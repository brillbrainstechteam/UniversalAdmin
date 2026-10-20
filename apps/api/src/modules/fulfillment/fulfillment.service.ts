import { Injectable } from '@nestjs/common';
import type {
  CancelRemainingRequest,
  CreateShipmentRequest,
  Order,
  ShipmentActionRequest,
  ShipShipmentRequest,
} from '@uc/contracts';
import {
  addOrderEvent,
  dispatchStock,
  enqueueEvent,
  orderLines,
  orders,
  recordCustomerMessage,
  releaseReservation,
  reservations,
  shipmentLines,
  shipments,
  writeAudit,
  type OrderRow,
  type Tx,
} from '@uc/db';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { AppError, Errors } from '../../common/errors';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';
import { loadOrder, requireOrders, toOrder } from '../orders/orders.common';
import { fulfillmentStatusOf, lineProgress, requireFulfillment, valueOfUnits } from './fulfillment.common';

/**
 * Pick-pack-ship (Phase 09, ADR-024). A shipment is packed from what is still committed, then dispatched — the
 * stock leaves through the ledger — then marked delivered. Carrier/tracking are typed by staff; nothing is tracked.
 */
@Injectable()
export class FulfillmentService {
  constructor(private readonly db: DbService) {}

  private audit(
    tx: Tx,
    auth: AuthState,
    ctx: TenantState,
    meta: RequestMeta,
    action: string,
    id: string,
    values: Record<string, unknown>,
    reason: string | null = null,
  ) {
    return writeAudit(tx, {
      tenantId: ctx.tenantId,
      actorType: 'user',
      actorUserId: auth.userId,
      action,
      entityType: 'order',
      entityId: id,
      oldValues: null,
      newValues: values,
      reason,
      correlationId: meta.correlationId,
      ip: meta.ip,
    });
  }

  private guard(ctx: TenantState) {
    requireOrders(ctx);
    requireFulfillment(ctx);
  }

  /** Recomputes and stores the order's fulfilment status. */
  static async refreshStatus(tx: Tx, order: OrderRow): Promise<void> {
    const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, order.id));
    const status = fulfillmentStatusOf(lines, await lineProgress(tx, lines));
    if (status !== order.fulfillmentStatus)
      await tx
        .update(orders)
        .set({ fulfillmentStatus: status, updatedAt: new Date() })
        .where(eq(orders.id, order.id));
  }

  async create(
    auth: AuthState,
    ctx: TenantState,
    orderId: string,
    input: CreateShipmentRequest,
    meta: RequestMeta,
  ): Promise<Order> {
    this.guard(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const order = await loadOrder(tx, ctx.tenantId, orderId, true);
      if (order.status !== 'confirmed')
        throw Errors.conflict(
          'INVALID_STATE_TRANSITION',
          `Only confirmed orders can be shipped (order ${order.number} is ${order.status})`,
        );
      const lines = await tx
        .select()
        .from(orderLines)
        .where(eq(orderLines.orderId, order.id))
        .orderBy(asc(orderLines.lineNo));
      const progress = await lineProgress(tx, lines);
      const wanted = new Map<number, number>();
      for (const l of input.lines) wanted.set(l.lineNo, (wanted.get(l.lineNo) ?? 0) + l.quantity);
      const picked = [...wanted].map(([lineNo, quantity]) => {
        const line = lines.find((l) => l.lineNo === lineNo);
        if (!line) throw Errors.validation({ lineNo }, `Order ${order.number} has no line ${lineNo}`);
        const can = progress.get(line.id)!.shippable;
        if (quantity > can)
          throw Errors.conflict(
            'INSUFFICIENT_STOCK',
            `Line ${lineNo} (${line.sku}): only ${can} unit(s) left to ship`,
            { lineNo, shippable: can },
          );
        return { line, quantity };
      });
      const [{ n }] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(shipments)
        .where(eq(shipments.orderId, order.id))) as [{ n: number }];
      const [shipment] = await tx
        .insert(shipments)
        .values({
          tenantId: ctx.tenantId,
          orderId: order.id,
          number: `${order.number}-S${n + 1}`,
          note: input.note,
          createdBy: auth.userId,
        })
        .returning();
      await tx.insert(shipmentLines).values(
        picked.map((p) => ({
          tenantId: ctx.tenantId,
          shipmentId: shipment!.id,
          orderLineId: p.line.id,
          quantity: p.quantity,
        })),
      );
      await addOrderEvent(tx, {
        tenantId: ctx.tenantId,
        orderId: order.id,
        type: 'shipment_packed',
        actorUserId: auth.userId,
        data: {
          shipment: shipment!.number,
          lines: picked.map((p) => ({ lineNo: p.line.lineNo, quantity: p.quantity })),
        },
      });
      await this.audit(tx, auth, ctx, meta, 'fulfillment.shipment_packed', order.id, {
        shipment: shipment!.number,
      });
      return toOrder(tx, order);
    });
  }

  private async loadShipment(tx: Tx, ctx: TenantState, orderId: string, shipmentId: string, version: number) {
    const order = await loadOrder(tx, ctx.tenantId, orderId, true);
    const [s] = await tx
      .select()
      .from(shipments)
      .where(and(eq(shipments.id, shipmentId), eq(shipments.orderId, order.id)))
      .for('update');
    if (!s || s.tenantId !== ctx.tenantId) throw Errors.notFound('Shipment');
    if (s.version !== version) throw Errors.versionConflict(s.version);
    return { order, s };
  }

  async ship(
    auth: AuthState,
    ctx: TenantState,
    orderId: string,
    shipmentId: string,
    input: ShipShipmentRequest,
    meta: RequestMeta,
  ): Promise<Order> {
    this.guard(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const { order, s } = await this.loadShipment(tx, ctx, orderId, shipmentId, input.version);
      if (s.status !== 'packed')
        throw Errors.conflict('INVALID_STATE_TRANSITION', `Shipment ${s.number} is ${s.status}`);
      if (order.status !== 'confirmed')
        throw Errors.conflict('INVALID_STATE_TRANSITION', `Order ${order.number} is ${order.status}`);
      const sl = await tx
        .select({ qty: shipmentLines.quantity, reservationId: orderLines.reservationId, sku: orderLines.sku })
        .from(shipmentLines)
        .innerJoin(orderLines, eq(orderLines.id, shipmentLines.orderLineId))
        .where(eq(shipmentLines.shipmentId, s.id));
      const missing = sl.find((l) => !l.reservationId);
      if (missing)
        throw Errors.conflict(
          'INVALID_STATE_TRANSITION',
          `${missing.sku} has no stock commitment to ship from`,
        );
      const now = new Date();
      await dispatchStock(tx, {
        tenantId: ctx.tenantId,
        reference: s.number,
        actorUserId: auth.userId,
        correlationId: meta.correlationId,
        items: sl.map((l) => ({ reservationId: l.reservationId!, quantity: String(l.qty) })),
        now,
      });
      await tx
        .update(shipments)
        .set({
          status: 'shipped',
          carrier: input.carrier,
          trackingNumber: input.trackingNumber,
          shippedAt: now,
          version: s.version + 1,
          updatedAt: now,
        })
        .where(eq(shipments.id, s.id));
      await FulfillmentService.refreshStatus(tx, order);
      await addOrderEvent(tx, {
        tenantId: ctx.tenantId,
        orderId: order.id,
        type: 'shipment_shipped',
        actorUserId: auth.userId,
        note: `${input.carrier}${input.trackingNumber ? ` · ${input.trackingNumber}` : ''} (entered manually, not tracked)`,
        data: { shipment: s.number },
        at: now,
      });
      await enqueueEvent(tx, {
        tenantId: ctx.tenantId,
        eventType: 'ShipmentDispatched',
        aggregateType: 'shipment',
        aggregateId: s.id,
        correlationId: meta.correlationId,
        payload: {
          shipmentId: s.id,
          number: s.number,
          orderId: order.id,
          carrier: input.carrier,
          trackingNumber: input.trackingNumber,
        },
      });
      await recordCustomerMessage(tx, {
        tenantId: ctx.tenantId,
        order,
        template: 'order_shipped',
        detail: `Carrier: ${input.carrier}${input.trackingNumber ? `, tracking number ${input.trackingNumber}` : ''}.`,
        now,
      });
      await this.audit(tx, auth, ctx, meta, 'fulfillment.shipment_shipped', order.id, {
        shipment: s.number,
        carrier: input.carrier,
        trackingNumber: input.trackingNumber,
      });
      return toOrder(tx, (await loadOrder(tx, ctx.tenantId, order.id))!);
    });
  }

  async deliver(
    auth: AuthState,
    ctx: TenantState,
    orderId: string,
    shipmentId: string,
    input: ShipmentActionRequest,
    meta: RequestMeta,
  ): Promise<Order> {
    this.guard(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const { order, s } = await this.loadShipment(tx, ctx, orderId, shipmentId, input.version);
      if (s.status !== 'shipped')
        throw Errors.conflict('INVALID_STATE_TRANSITION', `Shipment ${s.number} is ${s.status}`);
      const now = new Date();
      await tx
        .update(shipments)
        .set({ status: 'delivered', deliveredAt: now, version: s.version + 1, updatedAt: now })
        .where(eq(shipments.id, s.id));
      await addOrderEvent(tx, {
        tenantId: ctx.tenantId,
        orderId: order.id,
        type: 'shipment_delivered',
        actorUserId: auth.userId,
        data: { shipment: s.number },
        at: now,
      });
      await enqueueEvent(tx, {
        tenantId: ctx.tenantId,
        eventType: 'ShipmentDelivered',
        aggregateType: 'shipment',
        aggregateId: s.id,
        correlationId: meta.correlationId,
        payload: { shipmentId: s.id, number: s.number, orderId: order.id },
      });
      await recordCustomerMessage(tx, { tenantId: ctx.tenantId, order, template: 'order_delivered', now });
      await this.audit(tx, auth, ctx, meta, 'fulfillment.shipment_delivered', order.id, {
        shipment: s.number,
      });
      return toOrder(tx, order);
    });
  }

  /** Unpacks a shipment that has not left (no stock effect: nothing moved yet). */
  async cancel(
    auth: AuthState,
    ctx: TenantState,
    orderId: string,
    shipmentId: string,
    input: ShipmentActionRequest,
    meta: RequestMeta,
  ): Promise<Order> {
    this.guard(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const { order, s } = await this.loadShipment(tx, ctx, orderId, shipmentId, input.version);
      if (s.status !== 'packed')
        throw Errors.conflict(
          'INVALID_STATE_TRANSITION',
          `Shipment ${s.number} has already ${s.status === 'cancelled' ? 'been cancelled' : 'left'}; record a return instead`,
        );
      const now = new Date();
      await tx
        .update(shipments)
        .set({ status: 'cancelled', cancelledAt: now, version: s.version + 1, updatedAt: now })
        .where(eq(shipments.id, s.id));
      await addOrderEvent(tx, {
        tenantId: ctx.tenantId,
        orderId: order.id,
        type: 'shipment_cancelled',
        actorUserId: auth.userId,
        data: { shipment: s.number },
        at: now,
      });
      await this.audit(tx, auth, ctx, meta, 'fulfillment.shipment_cancelled', order.id, {
        shipment: s.number,
      });
      return toOrder(tx, order);
    });
  }

  /**
   * After a partial shipment: releases what has not shipped (packed shipments are unpacked first) through the
   * ledger and records the refund due for exactly the unshipped value of a paid order.
   */
  async cancelRemaining(
    auth: AuthState,
    ctx: TenantState,
    orderId: string,
    input: CancelRemainingRequest,
    meta: RequestMeta,
  ): Promise<Order> {
    this.guard(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const order = await loadOrder(tx, ctx.tenantId, orderId, true);
      if (order.status !== 'confirmed')
        throw Errors.conflict('INVALID_STATE_TRANSITION', `Order ${order.number} is ${order.status}`);
      if (order.fulfillmentStatus === 'unfulfilled')
        throw Errors.conflict(
          'INVALID_STATE_TRANSITION',
          `Nothing on order ${order.number} has shipped yet; cancel the order instead`,
        );
      const now = new Date();
      const packed = await tx
        .select()
        .from(shipments)
        .where(and(eq(shipments.orderId, order.id), eq(shipments.status, 'packed')));
      for (const p of packed)
        await tx
          .update(shipments)
          .set({ status: 'cancelled', cancelledAt: now, version: p.version + 1, updatedAt: now })
          .where(eq(shipments.id, p.id));
      const lines = await tx
        .select()
        .from(orderLines)
        .where(eq(orderLines.orderId, order.id))
        .orderBy(asc(orderLines.lineNo));
      const resIds = lines.map((l) => l.reservationId).filter((x): x is string => !!x);
      const open = resIds.length
        ? await tx
            .select()
            .from(reservations)
            .where(and(inArray(reservations.id, resIds), eq(reservations.status, 'committed')))
        : [];
      if (!open.length)
        throw Errors.conflict('INVALID_STATE_TRANSITION', `Nothing on order ${order.number} is left to ship`);
      let unshippedValue = 0n;
      const released: { lineNo: number; quantity: number; valueMinor: string }[] = [];
      for (const r of open) {
        const line = lines.find((l) => l.reservationId === r.id)!;
        const remaining = line.quantity - Number.parseInt(r.fulfilledQuantity, 10);
        await releaseReservation(tx, {
          tenantId: ctx.tenantId,
          reservationId: r.id,
          actorUserId: auth.userId,
          correlationId: meta.correlationId,
          reason: `Order ${order.number}: unshipped items cancelled — ${input.reason}`,
          now,
        });
        const value = valueOfUnits(line.totalMinor, line.quantity, line.quantity - remaining, remaining);
        unshippedValue += value;
        released.push({ lineNo: line.lineNo, quantity: remaining, valueMinor: value.toString() });
      }
      const paid =
        order.paymentStatus === 'paid' ||
        order.paymentStatus === 'partially_refunded' ||
        order.paymentStatus === 'refund_due';
      const refundDue = paid ? order.refundDueMinor + unshippedValue : order.refundDueMinor;
      await tx
        .update(orders)
        .set({
          ...(paid ? { refundDueMinor: refundDue, paymentStatus: 'refund_due' as const } : {}),
          version: sql`${orders.version} + 1`,
          updatedAt: now,
        })
        .where(eq(orders.id, order.id));
      const fresh = await loadOrder(tx, ctx.tenantId, order.id);
      await FulfillmentService.refreshStatus(tx, fresh);
      await addOrderEvent(tx, {
        tenantId: ctx.tenantId,
        orderId: order.id,
        type: 'remaining_cancelled',
        actorUserId: auth.userId,
        note: input.reason,
        data: { released, refundDueMinor: paid ? unshippedValue.toString() : '0' },
        at: now,
      });
      await this.audit(
        tx,
        auth,
        ctx,
        meta,
        'orders.remaining_cancelled',
        order.id,
        { released },
        input.reason,
      );
      if (refundDue > order.totalMinor)
        throw new AppError(500, 'INTERNAL', 'Refund due would exceed the order total');
      return toOrder(tx, await loadOrder(tx, ctx.tenantId, order.id));
    });
  }
}
