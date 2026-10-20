import { randomUUID } from 'node:crypto';
import type {
  Address,
  Attribution,
  Contact,
  Order,
  OrderSettings,
  OrderSummary,
  QuoteLine,
} from '@uc/contracts';
import {
  addOrderEvent,
  channels,
  confirmOrder,
  connections,
  customers,
  discountRedemptions,
  discounts,
  locations,
  nextDocumentNumber,
  orderEvents,
  orderLines,
  orderSettings,
  orders,
  outboundCommands,
  payments,
  reservations,
  reserveStock,
  returns,
  users,
  type OrderRow,
  type Tx,
} from '@uc/db';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import { Errors } from '../../common/errors';
import { iso } from '../../common/mappers';
import type { TenantState } from '../../common/request';
import {
  lineProgress,
  loadMessages,
  loadRefunds,
  loadShipments,
  toReturns,
} from '../fulfillment/fulfillment.common';

export type SettingsRow = typeof orderSettings.$inferSelect;

export function requireOrders(ctx: Pick<TenantState, 'features'>) {
  if (!ctx.features.includes('orders')) throw Errors.featureNotEntitled('orders');
}

export async function loadOrderSettings(tx: Tx, tenantId: string): Promise<SettingsRow> {
  await tx.insert(orderSettings).values({ tenantId }).onConflictDoNothing();
  const [row] = await tx.select().from(orderSettings).where(eq(orderSettings.tenantId, tenantId));
  return row!;
}

export function toOrderSettings(r: SettingsRow): OrderSettings {
  return {
    approvalThresholdMinor: r.approvalThresholdMinor === null ? null : r.approvalThresholdMinor.toString(),
    checkoutHoldMinutes: r.checkoutHoldMinutes,
    quotationMaxDays: r.quotationMaxDays,
    orderPrefix: r.orderPrefix,
    quotationPrefix: r.quotationPrefix,
    returnWindowDays: r.returnWindowDays,
    version: r.version,
    updatedAt: iso(r.updatedAt),
  };
}

export async function loadOrder(tx: Tx, tenantId: string, id: string, lock = false): Promise<OrderRow> {
  const q = tx.select().from(orders).where(eq(orders.id, id));
  const [row] = lock ? await q.for('update') : await q;
  if (!row || row.tenantId !== tenantId) throw Errors.notFound('Order');
  return row;
}

export function toSummary(o: OrderRow, channelName: string | null, lineCount: number): OrderSummary {
  const contact = o.contact as Contact;
  return {
    id: o.id,
    number: o.number,
    channel: o.channelId ? { id: o.channelId, name: channelName ?? '' } : null,
    origin: o.origin,
    status: o.status,
    paymentStatus: o.paymentStatus,
    fulfillmentStatus: o.fulfillmentStatus,
    contactName: contact.name,
    contactEmail: contact.email,
    currency: o.currency,
    totalMinor: o.totalMinor.toString(),
    lineCount,
    createdAt: iso(o.createdAt),
  };
}

/** Full order with lines (frozen snapshots), holds, payments, timeline and ERP exports. */
export async function toOrder(tx: Tx, o: OrderRow): Promise<Order> {
  const [lines, pays, events, chan] = await Promise.all([
    tx.select().from(orderLines).where(eq(orderLines.orderId, o.id)).orderBy(asc(orderLines.lineNo)),
    tx.select().from(payments).where(eq(payments.orderId, o.id)).orderBy(desc(payments.createdAt)),
    tx.select().from(orderEvents).where(eq(orderEvents.orderId, o.id)).orderBy(asc(orderEvents.seq)),
    o.channelId
      ? tx.select({ name: channels.name }).from(channels).where(eq(channels.id, o.channelId))
      : Promise.resolve([]),
  ]);
  const resIds = lines.map((l) => l.reservationId).filter((x): x is string => !!x);
  const holds = resIds.length
    ? await tx
        .select({ id: reservations.id, status: reservations.status, location: locations.name })
        .from(reservations)
        .innerJoin(locations, eq(locations.id, reservations.locationId))
        .where(inArray(reservations.id, resIds))
    : [];
  const exports = await tx
    .select({
      name: connections.name,
      reference: outboundCommands.reference,
      status: outboundCommands.status,
      externalRef: outboundCommands.externalRef,
    })
    .from(outboundCommands)
    .innerJoin(connections, eq(connections.id, outboundCommands.connectionId))
    .where(eq(outboundCommands.reference, `ORDER:${o.number}`));
  const [progress, shipmentList, returnRows, refundList, messageList, cust] = await Promise.all([
    lineProgress(tx, lines),
    loadShipments(tx, o.id, lines),
    tx.select().from(returns).where(eq(returns.orderId, o.id)).orderBy(asc(returns.createdAt)),
    loadRefunds(tx, o.id),
    loadMessages(tx, o.id),
    o.customerId
      ? tx
          .select({ id: customers.id, name: customers.displayName, email: customers.email })
          .from(customers)
          .where(eq(customers.id, o.customerId))
      : Promise.resolve([]),
  ]);
  const returnList = await toReturns(tx, returnRows, new Map([[o.id, o]]));
  const redemptions = await tx
    .select({ code: discountRedemptions.code, name: discounts.name, amount: discountRedemptions.amountMinor })
    .from(discountRedemptions)
    .innerJoin(discounts, eq(discounts.id, discountRedemptions.discountId))
    .where(eq(discountRedemptions.orderId, o.id));
  const actorIds = [
    ...new Set(
      [o.createdBy, o.approvedBy, ...events.map((e) => e.actorUserId)].filter((x): x is string => !!x),
    ),
  ];
  const people = actorIds.length
    ? await tx
        .select({ id: users.id, name: users.displayName })
        .from(users)
        .where(inArray(users.id, actorIds))
    : [];
  const actor = (id: string | null) =>
    id ? { id, name: people.find((p) => p.id === id)?.name ?? 'Unknown' } : null;
  return {
    ...toSummary(o, chan[0]?.name ?? null, lines.length),
    paymentTerms: o.paymentTerms,
    contact: o.contact as Contact,
    shippingAddress: (o.shippingAddress as Address | null) ?? null,
    note: o.note,
    subtotalMinor: o.subtotalMinor.toString(),
    discountMinor: o.discountMinor.toString(),
    taxMinor: o.taxMinor.toString(),
    refundDueMinor: o.refundDueMinor.toString(),
    priceQuoteId: o.priceQuoteId,
    quotationId: o.quotationId,
    lines: lines.map((l) => {
      const h = holds.find((x) => x.id === l.reservationId);
      return {
        lineNo: l.lineNo,
        variantId: l.variantId,
        serialItemId: l.serialItemId,
        sku: l.sku,
        title: l.title,
        serialTag: l.serialTag,
        quantity: l.quantity,
        totalMinor: l.totalMinor.toString(),
        priceSnapshot: l.priceSnapshot as QuoteLine,
        reservation: h ? { id: h.id, status: h.status, locationName: h.location } : null,
        shippedQuantity: progress.get(l.id)?.shipped ?? 0,
        shippableQuantity: progress.get(l.id)?.shippable ?? 0,
        returnedQuantity: progress.get(l.id)?.returned ?? 0,
      };
    }),
    payments: pays.map((p) => ({
      id: p.id,
      provider: p.provider,
      status: p.status,
      amountMinor: p.amountMinor.toString(),
      currency: p.currency,
      failureReason: p.failureReason,
      refundedMinor: p.refundedMinor.toString(),
      createdAt: iso(p.createdAt),
      updatedAt: iso(p.updatedAt),
    })),
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      actor: actor(e.actorUserId),
      note: e.note,
      data: e.data as Record<string, unknown>,
      createdAt: iso(e.createdAt),
    })),
    exports: exports.map((x) => ({
      connectionName: x.name,
      reference: x.reference,
      status: x.status,
      externalRef: x.externalRef,
    })),
    createdBy: actor(o.createdBy),
    approvedBy: actor(o.approvedBy),
    approvedAt: o.approvedAt ? iso(o.approvedAt) : null,
    confirmedAt: o.confirmedAt ? iso(o.confirmedAt) : null,
    cancelledAt: o.cancelledAt ? iso(o.cancelledAt) : null,
    cancelReason: o.cancelReason,
    expiresAt: o.expiresAt ? iso(o.expiresAt) : null,
    warnings: (o.warnings as string[]) ?? [],
    customer: cust[0] ?? null,
    attribution: (o.attribution as Attribution | null) ?? null,
    promotions: redemptions.map((r) => ({ code: r.code, name: r.name, amountMinor: r.amount.toString() })),
    shipments: shipmentList,
    returns: returnList,
    refunds: refundList,
    messages: messageList,
    version: o.version,
  };
}

export interface PlaceOrderInput {
  tenantId: string;
  channelId: string | null;
  origin: 'storefront' | 'admin' | 'quotation';
  paymentTerms: 'prepaid' | 'on_account';
  contact: Contact;
  shippingAddress: Address | null;
  note: string | null;
  priced: QuoteLine[];
  currency: string;
  subtotalMinor: bigint;
  discountMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
  priceQuoteId: string | null;
  quotationId?: string | null;
  cartId?: string | null;
  checkoutKey?: string | null;
  /** What happens after the holds are placed. */
  /** Phase 08 B2B: buying company, delivery location, buyer, purchase order number. */
  companyId?: string | null;
  /** Phase 10: marketing attribution from the storefront checkout. */
  attribution?: Attribution | null;
  /** Phase 09: signed-in storefront customer. */
  customerId?: string | null;
  companyLocationId?: string | null;
  buyerId?: string | null;
  poNumber?: string | null;
  next: 'pending_payment' | 'awaiting_buyer_approval' | 'awaiting_approval' | 'confirm';
  holdMinutes: number;
  actorUserId: string | null;
  correlationId: string | null;
  now: Date;
}

/**
 * Holds every line (all-or-nothing inside the caller's transaction: one unavailable line rolls everything back),
 * then creates the order with immutable line snapshots and its first timeline event; `confirm` commits at once.
 */
export async function placeOrder(tx: Tx, input: PlaceOrderInput): Promise<OrderRow> {
  const orderId = randomUUID();
  const number = await nextDocumentNumber(tx, input.tenantId, 'order');
  const holds: string[] = [];
  for (const [i, line] of input.priced.entries()) {
    const { reservation } = await reserveStock(tx, {
      tenantId: input.tenantId,
      variantId: line.variantId,
      quantity: String(line.quantity),
      serialItemId: line.serialItemId ?? undefined,
      channelId: input.channelId ?? undefined,
      referenceType: input.origin === 'storefront' ? 'checkout' : 'order',
      referenceId: orderId,
      ttlMinutes: input.holdMinutes,
      idempotencyKey: `order:${orderId}:${i + 1}`,
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
      allowedLocationIds: null,
      now: input.now,
    });
    holds.push(reservation.id);
  }
  const status =
    input.next === 'awaiting_approval' || input.next === 'awaiting_buyer_approval'
      ? input.next
      : ('pending_payment' as const);
  const [order] = await tx
    .insert(orders)
    .values({
      id: orderId,
      tenantId: input.tenantId,
      number,
      channelId: input.channelId,
      origin: input.origin,
      status,
      paymentStatus: input.paymentTerms === 'prepaid' ? 'pending' : 'unpaid',
      paymentTerms: input.paymentTerms,
      currency: input.currency,
      subtotalMinor: input.subtotalMinor,
      discountMinor: input.discountMinor,
      taxMinor: input.taxMinor,
      totalMinor: input.totalMinor,
      contact: input.contact,
      shippingAddress: input.shippingAddress,
      note: input.note,
      priceQuoteId: input.priceQuoteId,
      quotationId: input.quotationId ?? null,
      cartId: input.cartId ?? null,
      checkoutKey: input.checkoutKey ?? null,
      companyId: input.companyId ?? null,
      customerId: input.customerId ?? null,
      attribution: input.attribution ?? null,
      companyLocationId: input.companyLocationId ?? null,
      buyerId: input.buyerId ?? null,
      poNumber: input.poNumber ?? null,
      warnings: [...new Set(input.priced.flatMap((l) => l.breakdown.warnings))],
      createdBy: input.actorUserId,
      expiresAt: input.next === 'confirm' ? null : new Date(input.now.getTime() + input.holdMinutes * 60_000),
      createdAt: input.now,
    })
    .returning();
  await tx.insert(orderLines).values(
    input.priced.map((l, i) => ({
      tenantId: input.tenantId,
      orderId,
      lineNo: i + 1,
      variantId: l.variantId,
      serialItemId: l.serialItemId,
      sku: l.sku,
      title: l.title,
      serialTag: l.serialTag,
      quantity: l.quantity,
      totalMinor: BigInt(l.breakdown.totalMinor),
      priceSnapshot: l,
      reservationId: holds[i]!,
    })),
  );
  await addOrderEvent(tx, {
    tenantId: input.tenantId,
    orderId,
    type: 'created',
    toStatus: status,
    actorUserId: input.actorUserId,
    data: {
      origin: input.origin,
      totalMinor: input.totalMinor.toString(),
      currency: input.currency,
      holds: holds.length,
    },
    at: input.now,
  });
  if (input.next === 'confirm') {
    const { order: confirmed } = await confirmOrder(tx, order!, {
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
      now: input.now,
    });
    return confirmed;
  }
  return order!;
}
