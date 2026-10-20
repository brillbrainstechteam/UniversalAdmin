import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { CreateRefundRequest, Order, SandboxWebhook } from '@uc/contracts';
import { addOrderEvent, payments, refunds, returns, writeAudit } from '@uc/db';
import { and, asc, eq } from 'drizzle-orm';
import { Errors } from '../../common/errors';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';
import { loadOrder, requireOrders, toOrder } from '../orders/orders.common';
import { PaymentsService } from '../orders/payments.service';

/**
 * Refunds (Phase 09, ADR-024). The amount is reserved on the payment under a row lock (`refunded_minor`, DB-checked
 * ≤ captured), the refund is created `pending`, and only the gateway's signed callback settles it. In this build the
 * gateway is the SANDBOX: it answers at once with the outcome staff chose, through the same verified webhook path.
 */
@Injectable()
export class RefundsService {
  constructor(
    private readonly db: DbService,
    private readonly payments: PaymentsService,
  ) {}

  async create(
    auth: AuthState,
    ctx: TenantState,
    orderId: string,
    input: CreateRefundRequest,
    key: string,
    meta: RequestMeta,
  ): Promise<Order> {
    requireOrders(ctx);
    if (!ctx.features.includes('payments')) throw Errors.featureNotEntitled('payments');
    this.payments.requireSandbox(); // never leave a refund pending with no gateway to settle it
    const amount = BigInt(input.amountMinor);
    const refund = await this.db.tenant(ctx.tenantId, async (tx) => {
      const order = await loadOrder(tx, ctx.tenantId, orderId, true);
      if (input.returnId) {
        const [r] = await tx
          .select()
          .from(returns)
          .where(and(eq(returns.id, input.returnId), eq(returns.orderId, order.id)));
        if (!r) throw Errors.notFound('Return');
        if (r.status !== 'approved' && r.status !== 'received')
          throw Errors.conflict('INVALID_STATE_TRANSITION', `Return ${r.number} is ${r.status}`);
      }
      const captured = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.orderId, order.id), eq(payments.status, 'captured')))
        .orderBy(asc(payments.createdAt))
        .for('update');
      const refundable = captured.reduce((a, p) => a + (p.amountMinor - p.refundedMinor), 0n);
      if (!captured.length)
        throw Errors.conflict(
          'REFUND_EXCEEDS_CAPTURED',
          `Order ${order.number} has no captured payment to refund`,
          { refundableMinor: '0' },
        );
      const payment = captured.find((p) => p.amountMinor - p.refundedMinor >= amount);
      if (!payment)
        throw Errors.conflict(
          'REFUND_EXCEEDS_CAPTURED',
          `At most ${refundable.toString()} (minor units) can still be refunded on order ${order.number}`,
          {
            refundableMinor: refundable.toString(),
          },
        );
      await tx
        .update(payments)
        .set({
          refundedMinor: payment.refundedMinor + amount,
          version: payment.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(payments.id, payment.id));
      const [row] = await tx
        .insert(refunds)
        .values({
          tenantId: ctx.tenantId,
          orderId: order.id,
          paymentId: payment.id,
          returnId: input.returnId,
          provider: 'sandbox',
          amountMinor: amount,
          currency: payment.currency,
          reason: input.reason,
          createdBy: auth.userId,
          idempotencyKey: key,
        })
        .returning();
      await addOrderEvent(tx, {
        tenantId: ctx.tenantId,
        orderId: order.id,
        type: 'refund_requested',
        actorUserId: auth.userId,
        note: input.reason,
        data: { refundId: row!.id, amountMinor: input.amountMinor, provider: 'sandbox' },
      });
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: 'payments.refund_requested',
        entityType: 'order',
        entityId: order.id,
        oldValues: null,
        newValues: { refundId: row!.id, amountMinor: input.amountMinor, paymentId: payment.id },
        reason: input.reason,
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return row!;
    });
    // The sandbox gateway answers with a signed callback, handled exactly like a real PSP's.
    const event: SandboxWebhook = {
      eventId: `evt_${randomUUID()}`,
      paymentId: refund.paymentId,
      refundId: refund.id,
      outcome: input.sandboxOutcome,
      amountMinor: refund.amountMinor.toString(),
      currency: refund.currency,
      occurredAt: new Date().toISOString(),
    };
    await this.payments.handleWebhook(event, this.payments.sign(event));
    return this.db.tenant(ctx.tenantId, async (tx) =>
      toOrder(tx, await loadOrder(tx, ctx.tenantId, orderId)),
    );
  }
}
