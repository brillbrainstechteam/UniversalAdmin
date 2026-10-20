import type { CustomerMessage, OrderReturn, Refund, Shipment } from '@uc/contracts';
import { qtySub } from '@uc/contracts';
import {
  customerMessages,
  orderLines,
  orderSettings,
  refunds,
  reservations,
  returnLines,
  returns,
  shipmentLines,
  shipments,
  users,
  type Tx,
} from '@uc/db';
import { asc, eq, inArray } from 'drizzle-orm';
import { Errors } from '../../common/errors';
import { iso } from '../../common/mappers';
import type { TenantState } from '../../common/request';

type OrderRow = { id: string; number: string; currency: string };
type LineRow = typeof orderLines.$inferSelect;
export type ShipmentRow = typeof shipments.$inferSelect;
export type ReturnRow = typeof returns.$inferSelect;

export function requireFulfillment(ctx: Pick<TenantState, 'features'>) {
  if (!ctx.features.includes('fulfillment')) throw Errors.featureNotEntitled('fulfillment');
}

/** Whole units of a ledger quantity string ("2.000000" → 2). Order lines are always whole pieces. */
const units = (q: string) => Number.parseInt(q, 10);

export interface LineProgress {
  shipped: number;
  /** In packed (not yet dispatched) shipments. */
  packed: number;
  /** Committed and not yet in any shipment. */
  shippable: number;
  /** In a return that is requested, approved or received. */
  inReturn: number;
  /** Received back on a return. */
  returned: number;
}

/** Per order line: what shipped, what is packed, what can still ship, what is (being) returned. */
export async function lineProgress(tx: Tx, lines: LineRow[]): Promise<Map<string, LineProgress>> {
  const ids = lines.map((l) => l.id);
  const resIds = lines.map((l) => l.reservationId).filter((x): x is string => !!x);
  const [shipRows, retRows, resRows] = await Promise.all([
    ids.length
      ? tx
          .select({
            lineId: shipmentLines.orderLineId,
            qty: shipmentLines.quantity,
            status: shipments.status,
          })
          .from(shipmentLines)
          .innerJoin(shipments, eq(shipments.id, shipmentLines.shipmentId))
          .where(inArray(shipmentLines.orderLineId, ids))
      : [],
    ids.length
      ? tx
          .select({ lineId: returnLines.orderLineId, qty: returnLines.quantity, status: returns.status })
          .from(returnLines)
          .innerJoin(returns, eq(returns.id, returnLines.returnId))
          .where(inArray(returnLines.orderLineId, ids))
      : [],
    resIds.length ? tx.select().from(reservations).where(inArray(reservations.id, resIds)) : [],
  ]);
  const out = new Map<string, LineProgress>();
  for (const l of lines) {
    const mine = shipRows.filter((s) => s.lineId === l.id);
    const shipped = mine
      .filter((s) => s.status === 'shipped' || s.status === 'delivered')
      .reduce((a, s) => a + s.qty, 0);
    const packed = mine.filter((s) => s.status === 'packed').reduce((a, s) => a + s.qty, 0);
    const res = resRows.find((r) => r.id === l.reservationId);
    const committedLeft =
      res && res.status === 'committed' ? units(qtySub(res.quantity, res.fulfilledQuantity)) : 0;
    const rets = retRows.filter((r) => r.lineId === l.id);
    out.set(l.id, {
      shipped,
      packed,
      shippable: Math.max(0, committedLeft - packed),
      inReturn: rets.filter((r) => r.status !== 'rejected').reduce((a, r) => a + r.qty, 0),
      returned: rets.filter((r) => r.status === 'received').reduce((a, r) => a + r.qty, 0),
    });
  }
  return out;
}

export function fulfillmentStatusOf(lines: LineRow[], progress: Map<string, LineProgress>) {
  const shipped = lines.reduce((a, l) => a + (progress.get(l.id)?.shipped ?? 0), 0);
  const open = lines.reduce(
    (a, l) => a + (progress.get(l.id)?.shippable ?? 0) + (progress.get(l.id)?.packed ?? 0),
    0,
  );
  if (shipped === 0) return 'unfulfilled' as const;
  return open === 0 ? ('fulfilled' as const) : ('partial' as const);
}

async function names(tx: Tx, ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const rows = unique.length
    ? await tx.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, unique))
    : [];
  return (id: string | null) => (id ? { id, name: rows.find((r) => r.id === id)?.name ?? 'Unknown' } : null);
}

export async function loadShipments(tx: Tx, orderId: string, lines: LineRow[]): Promise<Shipment[]> {
  const rows = await tx
    .select()
    .from(shipments)
    .where(eq(shipments.orderId, orderId))
    .orderBy(asc(shipments.createdAt));
  if (!rows.length) return [];
  const sl = await tx
    .select()
    .from(shipmentLines)
    .where(
      inArray(
        shipmentLines.shipmentId,
        rows.map((r) => r.id),
      ),
    );
  const actor = await names(
    tx,
    rows.map((r) => r.createdBy),
  );
  return rows.map((s) => ({
    id: s.id,
    number: s.number,
    status: s.status,
    carrier: s.carrier,
    trackingNumber: s.trackingNumber,
    trackingManual: true as const,
    note: s.note,
    lines: sl
      .filter((x) => x.shipmentId === s.id)
      .map((x) => {
        const l = lines.find((y) => y.id === x.orderLineId)!;
        return { lineNo: l.lineNo, sku: l.sku, title: l.title, serialTag: l.serialTag, quantity: x.quantity };
      })
      .sort((a, b) => a.lineNo - b.lineNo),
    createdBy: actor(s.createdBy),
    createdAt: iso(s.createdAt),
    shippedAt: s.shippedAt ? iso(s.shippedAt) : null,
    deliveredAt: s.deliveredAt ? iso(s.deliveredAt) : null,
    cancelledAt: s.cancelledAt ? iso(s.cancelledAt) : null,
    version: s.version,
  }));
}

export async function toReturns(
  tx: Tx,
  rows: ReturnRow[],
  ordersById: Map<string, OrderRow>,
): Promise<OrderReturn[]> {
  if (!rows.length) return [];
  const rl = await tx
    .select({ r: returnLines, l: orderLines })
    .from(returnLines)
    .innerJoin(orderLines, eq(orderLines.id, returnLines.orderLineId))
    .where(
      inArray(
        returnLines.returnId,
        rows.map((r) => r.id),
      ),
    );
  const actor = await names(
    tx,
    rows.map((r) => r.decidedBy),
  );
  return rows.map((r) => {
    const mine = rl.filter((x) => x.r.returnId === r.id).sort((a, b) => a.l.lineNo - b.l.lineNo);
    const o = ordersById.get(r.orderId)!;
    return {
      id: r.id,
      number: r.number,
      orderId: r.orderId,
      orderNumber: o.number,
      status: r.status,
      reason: r.reason,
      requestedBy: r.requestedBy,
      currency: o.currency,
      valueMinor: mine.reduce((a, x) => a + x.r.valueMinor, 0n).toString(),
      lines: mine.map((x) => ({
        lineNo: x.l.lineNo,
        sku: x.l.sku,
        title: x.l.title,
        serialTag: x.l.serialTag,
        quantity: x.r.quantity,
        valueMinor: x.r.valueMinor.toString(),
      })),
      decidedBy: actor(r.decidedBy),
      decidedAt: r.decidedAt ? iso(r.decidedAt) : null,
      decisionNote: r.decisionNote,
      receivedAt: r.receivedAt ? iso(r.receivedAt) : null,
      restocked: r.restocked,
      createdAt: iso(r.createdAt),
      version: r.version,
    };
  });
}

export async function loadRefunds(tx: Tx, orderId: string): Promise<Refund[]> {
  const rows = await tx
    .select()
    .from(refunds)
    .where(eq(refunds.orderId, orderId))
    .orderBy(asc(refunds.createdAt));
  const actor = await names(
    tx,
    rows.map((r) => r.createdBy),
  );
  return rows.map((r) => ({
    id: r.id,
    paymentId: r.paymentId,
    returnId: r.returnId,
    provider: r.provider,
    status: r.status,
    amountMinor: r.amountMinor.toString(),
    currency: r.currency,
    reason: r.reason,
    failureReason: r.failureReason,
    createdBy: actor(r.createdBy),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  }));
}

export async function loadMessages(tx: Tx, orderId: string): Promise<CustomerMessage[]> {
  const rows = await tx
    .select()
    .from(customerMessages)
    .where(eq(customerMessages.orderId, orderId))
    .orderBy(asc(customerMessages.createdAt));
  return rows.map((m) => ({
    id: m.id,
    template: m.template,
    channel: m.channel,
    recipient: m.recipient,
    subject: m.subject,
    body: m.body,
    status: m.status,
    statusReason: m.statusReason,
    createdAt: iso(m.createdAt),
  }));
}

/** Allocates a line total over `quantity` units exactly: the value of `n` of them (remainder on the first units). */
export function valueOfUnits(totalMinor: bigint, quantity: number, from: number, n: number): bigint {
  const q = BigInt(quantity);
  const base = totalMinor / q;
  const rem = totalMinor % q;
  let v = 0n;
  for (let i = from; i < from + n; i++) v += base + (BigInt(i) < rem ? 1n : 0n);
  return v;
}

/** Return deadline: window days after the latest delivery (or dispatch when not marked delivered). */
export async function returnDeadline(
  tx: Tx,
  tenantId: string,
  ships: ShipmentRow[] | Shipment[],
): Promise<Date | null> {
  const times = ships
    .filter((s) => s.status === 'shipped' || s.status === 'delivered')
    .map((s) => {
      const t = 'deliveredAt' in s && s.deliveredAt ? s.deliveredAt : s.shippedAt;
      return t ? new Date(t) : null;
    })
    .filter((x): x is Date => !!x);
  if (!times.length) return null;
  const [settings] = await tx
    .select({ days: orderSettings.returnWindowDays })
    .from(orderSettings)
    .where(eq(orderSettings.tenantId, tenantId));
  const days = settings?.days ?? 14;
  const latest = Math.max(...times.map((t) => t.getTime()));
  return new Date(latest + days * 86_400_000);
}
