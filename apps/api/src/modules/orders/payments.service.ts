import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { SandboxWebhook } from '@uc/contracts';
import { addOrderEvent, confirmOrder, enqueueEvent, orders, paymentEvents, payments, type Tx } from '@uc/db';
import { and, eq, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { AppError } from '../../common/errors';
import { DbService } from '../../db/db.service';

/** Canonical bytes that are signed: the payload's keys in sorted order (both sides compute the same string). */
export function canonicalPayload(event: SandboxWebhook): string {
  return JSON.stringify(Object.fromEntries(Object.entries(event).sort(([a], [b]) => a.localeCompare(b))));
}

/**
 * SANDBOX payment gateway (ADR-022). It is a test double for a real PSP: no money moves. The "gateway" side signs
 * callbacks with HMAC-SHA256; the webhook side verifies the signature (timing-safe), rejects replays by event ID
 * and drives payment + order state exactly as a real PSP callback would. Disabled (and refused) in production.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private requireSandbox() {
    if (!this.config.PAYMENTS_SANDBOX_ENABLED)
      throw new AppError(
        403,
        'PAYMENTS_DISABLED',
        'The sandbox payment gateway is disabled in this environment',
      );
  }

  sign(event: SandboxWebhook): string {
    return createHmac('sha256', this.config.PAYMENTS_SANDBOX_SECRET)
      .update(canonicalPayload(event))
      .digest('hex');
  }

  private verify(event: SandboxWebhook, signature: string | undefined): boolean {
    if (!signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
    const expected = Buffer.from(this.sign(event), 'hex');
    const given = Buffer.from(signature, 'hex');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /** The simulated PSP: creates (or reuses) the pending payment, then delivers a signed callback to the webhook. */
  async simulate(tenantId: string, orderId: string, outcome: 'succeeded' | 'failed') {
    this.requireSandbox();
    const payment = await this.db.tenant(tenantId, async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
        .for('update');
      if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');
      if (order.status !== 'pending_payment' || order.paymentTerms !== 'prepaid')
        throw new AppError(
          409,
          'INVALID_STATE_TRANSITION',
          `Order ${order.number} is not waiting for payment`,
        );
      if (order.expiresAt && order.expiresAt.getTime() <= Date.now())
        throw new AppError(409, 'INVALID_STATE_TRANSITION', 'The payment window for this order has closed');
      const [pending] = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.orderId, order.id), eq(payments.status, 'pending')));
      if (pending) return pending;
      const [created] = await tx
        .insert(payments)
        .values({
          tenantId,
          orderId: order.id,
          provider: 'sandbox',
          amountMinor: order.totalMinor,
          currency: order.currency,
        })
        .returning();
      await tx
        .update(orders)
        .set({ paymentStatus: 'pending', updatedAt: new Date() })
        .where(eq(orders.id, order.id));
      await addOrderEvent(tx, {
        tenantId,
        orderId: order.id,
        type: 'payment_started',
        data: { paymentId: created!.id, provider: 'sandbox' },
      });
      return created!;
    });
    const event: SandboxWebhook = {
      eventId: `evt_${randomUUID()}`,
      paymentId: payment.id,
      outcome,
      amountMinor: payment.amountMinor.toString(),
      currency: payment.currency,
      occurredAt: new Date().toISOString(),
    };
    return this.handleWebhook(event, this.sign(event));
  }

  /** PSP callback (public, signed). Idempotent: a repeated event ID is acknowledged and ignored. */
  async handleWebhook(
    raw: unknown,
    signature: string | undefined,
  ): Promise<{ received: true; duplicate: boolean }> {
    this.requireSandbox();
    const parsed = SandboxWebhook.safeParse(raw);
    if (!parsed.success) throw new AppError(400, 'VALIDATION_FAILED', 'Malformed payment callback');
    const event = parsed.data;
    if (!this.verify(event, signature))
      throw new AppError(401, 'SIGNATURE_INVALID', 'Payment callback signature is invalid');
    // The payment ID tells us the tenant (callbacks are cross-tenant by nature); everything after runs tenant-scoped.
    const [owner] = await this.db.system((tx) =>
      tx.select({ tenantId: payments.tenantId }).from(payments).where(eq(payments.id, event.paymentId)),
    );
    if (!owner) throw new AppError(404, 'NOT_FOUND', 'Unknown payment');
    return this.db.tenant(owner.tenantId, async (tx) => {
      const [fresh] = await tx
        .insert(paymentEvents)
        .values({
          provider: 'sandbox',
          eventId: event.eventId,
          paymentId: event.paymentId,
          outcome: event.outcome,
        })
        .onConflictDoNothing()
        .returning({ eventId: paymentEvents.eventId });
      if (!fresh) return { received: true as const, duplicate: true };
      await this.apply(tx, owner.tenantId, event);
      return { received: true as const, duplicate: false };
    });
  }

  private async apply(tx: Tx, tenantId: string, event: SandboxWebhook) {
    const [payment] = await tx.select().from(payments).where(eq(payments.id, event.paymentId)).for('update');
    if (!payment || payment.tenantId !== tenantId) throw new AppError(404, 'NOT_FOUND', 'Unknown payment');
    if (payment.amountMinor.toString() !== event.amountMinor || payment.currency !== event.currency)
      throw new AppError(422, 'VALIDATION_FAILED', 'Callback amount does not match the payment');
    if (payment.status !== 'pending') return; // already settled by an earlier event
    const [order] = await tx.select().from(orders).where(eq(orders.id, payment.orderId)).for('update');
    const now = new Date();
    if (event.outcome === 'failed') {
      await tx
        .update(payments)
        .set({
          status: 'failed',
          failureReason: 'Declined (sandbox)',
          updatedAt: now,
          version: sql`${payments.version} + 1`,
        })
        .where(eq(payments.id, payment.id));
      if (order!.status === 'pending_payment')
        await tx
          .update(orders)
          .set({ paymentStatus: 'failed', updatedAt: now })
          .where(eq(orders.id, order!.id));
      await addOrderEvent(tx, {
        tenantId,
        orderId: order!.id,
        type: 'payment_failed',
        note: 'Declined by the sandbox gateway',
        data: { paymentId: payment.id, eventId: event.eventId },
        at: now,
      });
      await enqueueEvent(tx, {
        tenantId,
        eventType: 'PaymentFailed',
        aggregateType: 'payment',
        aggregateId: payment.id,
        payload: { paymentId: payment.id, orderId: order!.id },
      });
      return;
    }
    await tx
      .update(payments)
      .set({ status: 'captured', updatedAt: now, version: sql`${payments.version} + 1` })
      .where(eq(payments.id, payment.id));
    await addOrderEvent(tx, {
      tenantId,
      orderId: order!.id,
      type: 'payment_captured',
      note: 'Captured by the sandbox gateway (no real money)',
      data: { paymentId: payment.id, eventId: event.eventId, amountMinor: event.amountMinor },
      at: now,
    });
    await enqueueEvent(tx, {
      tenantId,
      eventType: 'PaymentCaptured',
      aggregateType: 'payment',
      aggregateId: payment.id,
      payload: {
        paymentId: payment.id,
        orderId: order!.id,
        amountMinor: event.amountMinor,
        currency: event.currency,
        sandbox: true,
      },
    });
    if (order!.status === 'pending_payment') {
      const [paid] = await tx
        .update(orders)
        .set({ paymentStatus: 'paid', updatedAt: now })
        .where(eq(orders.id, order!.id))
        .returning();
      await confirmOrder(tx, paid!, { actorUserId: null, now });
    } else {
      // Money arrived for an order that is no longer payable (e.g. cancelled when its window expired): refund due.
      await tx
        .update(orders)
        .set({ paymentStatus: 'refund_due', refundDueMinor: order!.totalMinor, updatedAt: now })
        .where(eq(orders.id, order!.id));
      await addOrderEvent(tx, {
        tenantId,
        orderId: order!.id,
        type: 'refund_due',
        note: `Payment captured after the order became ${order!.status}`,
        data: { paymentId: payment.id },
        at: now,
      });
    }
  }
}
