import { CONNECTORS } from '@uc/contracts';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Tx } from './client';
import { recordCustomerMessage } from './messages';
import { connections, outboundCommands } from './integrations-schema';
import { InventoryError, commitReservation, releaseReservation, reserveStock } from './inventory';
import { reservations } from './inventory-schema';
import { creditEntries, rfqs } from './b2b-schema';
import { shipments } from './b2c-schema';
import { orderEvents, orderLines, orderSettings, orders, quotations } from './orders-schema';
import { enqueueEvent } from './outbox';

/**
 * Order state machine shared by the API and the worker (ADR-022). Every function runs inside the caller's
 * transaction; stock always moves through the inventory engine (holds → commitments → releases).
 */
export type OrderRow = typeof orders.$inferSelect;
export type OrderLineRow = typeof orderLines.$inferSelect;

interface Actor {
  actorUserId: string | null;
  correlationId?: string | null;
  now?: Date;
}

/** Next human-readable number (ORD-000001) from a per-tenant counter row (row lock serialises numbering). */
export async function nextDocumentNumber(
  tx: Tx,
  tenantId: string,
  kind: 'order' | 'quotation' | 'rfq' | 'return',
): Promise<string> {
  await tx.insert(orderSettings).values({ tenantId }).onConflictDoNothing();
  const counters = {
    order: { next: orderSettings.nextOrderNumber, set: 'nextOrderNumber', prefix: 'orderPrefix' },
    quotation: {
      next: orderSettings.nextQuotationNumber,
      set: 'nextQuotationNumber',
      prefix: 'quotationPrefix',
    },
    rfq: { next: orderSettings.nextRfqNumber, set: 'nextRfqNumber', prefix: 'rfqPrefix' },
    return: { next: orderSettings.nextReturnNumber, set: 'nextReturnNumber', prefix: 'returnPrefix' },
  } as const;
  const c = counters[kind];
  const [row] = await tx
    .update(orderSettings)
    .set({ [c.set]: sql`${c.next} + 1` })
    .where(eq(orderSettings.tenantId, tenantId))
    .returning();
  return `${row![c.prefix]}-${String(row![c.set] - 1).padStart(6, '0')}`;
}

export async function addOrderEvent(
  tx: Tx,
  input: {
    tenantId: string;
    orderId: string;
    type: string;
    fromStatus?: string | null;
    toStatus?: string | null;
    actorUserId?: string | null;
    note?: string | null;
    data?: Record<string, unknown>;
    at?: Date;
  },
) {
  await tx.insert(orderEvents).values({
    tenantId: input.tenantId,
    orderId: input.orderId,
    type: input.type,
    fromStatus: input.fromStatus ?? null,
    toStatus: input.toStatus ?? null,
    actorUserId: input.actorUserId ?? null,
    note: input.note ?? null,
    data: input.data ?? {},
    ...(input.at ? { createdAt: input.at } : {}),
  });
}

/**
 * Queues the confirmed order for every active connection that can receive orders and has order export on.
 * The reference `ORDER:<number>` is unique per connection, so re-confirming never sends a second ERP order.
 */
export async function queueOrderExports(
  tx: Tx,
  order: OrderRow,
  correlationId: string | null = null,
): Promise<number> {
  const conns = await tx
    .select()
    .from(connections)
    .where(and(eq(connections.tenantId, order.tenantId), eq(connections.status, 'active')));
  const targets = conns.filter(
    (c) =>
      CONNECTORS[c.connectorKey]?.capabilities.pushOrders === true &&
      (c.settings as { exportOrders?: boolean } | null)?.exportOrders === true,
  );
  if (!targets.length) return 0;
  const lines = await tx
    .select()
    .from(orderLines)
    .where(eq(orderLines.orderId, order.id))
    .orderBy(asc(orderLines.lineNo));
  const payload = {
    kind: 'order',
    orderNumber: order.number,
    currency: order.currency,
    totalMinor: order.totalMinor.toString(),
    lines: lines.map((l) => ({ sku: l.sku, quantity: String(l.quantity), serialTag: l.serialTag })),
  };
  let queued = 0;
  for (const c of targets) {
    const [cmd] = await tx
      .insert(outboundCommands)
      .values({
        tenantId: order.tenantId,
        connectionId: c.id,
        kind: 'push_order',
        reference: `ORDER:${order.number}`,
        payload,
        nextAttemptAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: outboundCommands.id });
    if (!cmd) continue;
    queued++;
    await enqueueEvent(tx, {
      tenantId: order.tenantId,
      eventType: 'OrderExportRequested',
      aggregateType: 'outbound_command',
      aggregateId: cmd.id,
      correlationId,
      payload: { reference: `ORDER:${order.number}`, connectionId: c.id, orderId: order.id },
    });
  }
  return queued;
}

/**
 * Commits every line's hold. An expired or missing hold is re-reserved (the engine first expires due holds of
 * the variant); if the stock is gone the order goes `on_hold` for staff instead of overselling.
 */
export async function confirmOrder(
  tx: Tx,
  order: OrderRow,
  actor: Actor & { note?: string | null },
): Promise<{ order: OrderRow; warnings: string[] }> {
  const now = actor.now ?? new Date();
  const lines = await tx
    .select()
    .from(orderLines)
    .where(eq(orderLines.orderId, order.id))
    .orderBy(asc(orderLines.lineNo));
  const warnings: string[] = [];
  let onHold = false;
  for (const line of lines) {
    const [res] = line.reservationId
      ? await tx.select().from(reservations).where(eq(reservations.id, line.reservationId)).for('update')
      : [];
    if (res?.status === 'committed') continue;
    let reservationId = res?.id ?? null;
    const usable =
      res && res.status === 'held' && !(res.expiresAt && res.expiresAt.getTime() <= now.getTime());
    if (!usable) {
      try {
        const { reservation } = await tx.transaction((sp) =>
          reserveStock(sp, {
            tenantId: order.tenantId,
            variantId: line.variantId,
            quantity: String(line.quantity),
            serialItemId: line.serialItemId ?? undefined,
            channelId: order.channelId ?? undefined,
            referenceType: 'order',
            referenceId: order.id,
            ttlMinutes: 60,
            idempotencyKey: `order:${order.id}:${line.lineNo}:${now.getTime()}`,
            actorUserId: actor.actorUserId,
            correlationId: actor.correlationId ?? null,
            allowedLocationIds: null,
            now,
          }),
        );
        reservationId = reservation.id;
        await tx.update(orderLines).set({ reservationId }).where(eq(orderLines.id, line.id));
        warnings.push(`Line ${line.lineNo} (${line.sku}): the hold had expired and was reserved again`);
      } catch (e) {
        if (e instanceof InventoryError && e.code === 'INSUFFICIENT_STOCK') {
          onHold = true;
          warnings.push(`Line ${line.lineNo} (${line.sku}): no longer available — needs staff action`);
          continue;
        }
        throw e;
      }
    }
    await commitReservation(tx, {
      tenantId: order.tenantId,
      reservationId: reservationId!,
      actorUserId: actor.actorUserId,
      correlationId: actor.correlationId ?? null,
      now,
    });
  }
  const status = onHold ? ('on_hold' as const) : ('confirmed' as const);
  const [updated] = await tx
    .update(orders)
    .set({
      status,
      confirmedAt: onHold ? null : now,
      expiresAt: null,
      warnings: [...((order.warnings as string[]) ?? []), ...warnings],
      version: sql`${orders.version} + 1`,
      updatedAt: now,
    })
    .where(eq(orders.id, order.id))
    .returning();
  await addOrderEvent(tx, {
    tenantId: order.tenantId,
    orderId: order.id,
    type: onHold ? 'stock_exception' : 'confirmed',
    fromStatus: order.status,
    toStatus: status,
    actorUserId: actor.actorUserId,
    note: actor.note ?? (warnings.length ? warnings.join('; ') : null),
    at: now,
  });
  if (!onHold) {
    await enqueueEvent(tx, {
      tenantId: order.tenantId,
      eventType: 'OrderConfirmed',
      aggregateType: 'order',
      aggregateId: order.id,
      aggregateVersion: updated!.version,
      correlationId: actor.correlationId ?? null,
      payload: {
        orderId: order.id,
        number: order.number,
        totalMinor: order.totalMinor.toString(),
        currency: order.currency,
      },
    });
    if (order.origin === 'storefront')
      await recordCustomerMessage(tx, {
        tenantId: order.tenantId,
        order: updated!,
        template: 'order_confirmed',
        amountMinor: order.totalMinor,
        now,
      });
    const queued = await queueOrderExports(tx, updated!, actor.correlationId ?? null);
    if (queued)
      await addOrderEvent(tx, {
        tenantId: order.tenantId,
        orderId: order.id,
        type: 'export_queued',
        actorUserId: actor.actorUserId,
        data: { connections: queued, reference: `ORDER:${order.number}` },
        at: now,
      });
  }
  return { order: updated!, warnings };
}

/**
 * Cancels with compensation: held and committed stock is released through the ledger (with the reason), and a
 * captured payment becomes a refund due (refunds are executed in Phase 09).
 */
export async function cancelOrder(
  tx: Tx,
  order: OrderRow,
  actor: Actor & { reason: string; type?: string },
): Promise<OrderRow> {
  const now = actor.now ?? new Date();
  if (order.status === 'cancelled')
    throw new InventoryError(409, 'INVALID_STATE_TRANSITION', 'This order is already cancelled');
  // Phase 09: goods that left cannot be "cancelled" — cancel the unshipped items and take a return instead.
  if (order.fulfillmentStatus !== 'unfulfilled')
    throw new InventoryError(
      409,
      'ORDER_SHIPPED',
      `Order ${order.number} has shipped items; cancel the unshipped items and record a return instead`,
    );
  await tx
    .update(shipments)
    .set({ status: 'cancelled', cancelledAt: now, version: sql`${shipments.version} + 1`, updatedAt: now })
    .where(and(eq(shipments.orderId, order.id), eq(shipments.status, 'packed')));
  const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, order.id));
  const resIds = lines.map((l) => l.reservationId).filter((x): x is string => !!x);
  const open = resIds.length
    ? await tx
        .select()
        .from(reservations)
        .where(and(inArray(reservations.id, resIds), inArray(reservations.status, ['held', 'committed'])))
    : [];
  for (const r of open)
    await releaseReservation(tx, {
      tenantId: order.tenantId,
      reservationId: r.id,
      actorUserId: actor.actorUserId,
      correlationId: actor.correlationId ?? null,
      reason: `Order ${order.number} cancelled: ${actor.reason}`,
      now,
    });
  // Pending payments are left open on purpose: a PSP may still capture them, and a late capture on a cancelled
  // order then records a refund due (see PaymentsService) instead of being lost.
  // On-account company orders release the credit they reserved (once; the ledger is append-only).
  if (order.companyId) {
    const charged = await tx
      .select({ amount: creditEntries.amountMinor, type: creditEntries.type })
      .from(creditEntries)
      .where(eq(creditEntries.orderId, order.id));
    const charge = charged.find((c) => c.type === 'order_charge');
    if (charge && !charged.some((c) => c.type === 'order_release'))
      await tx.insert(creditEntries).values({
        tenantId: order.tenantId,
        companyId: order.companyId,
        type: 'order_release',
        amountMinor: -charge.amount,
        reference: order.number,
        orderId: order.id,
        note: `Order ${order.number} cancelled: ${actor.reason}`,
        actorUserId: actor.actorUserId,
        createdAt: now,
      });
  }
  const paid = order.paymentStatus === 'paid';
  const exported = await tx
    .select({ ref: outboundCommands.reference, status: outboundCommands.status })
    .from(outboundCommands)
    .where(
      and(
        eq(outboundCommands.tenantId, order.tenantId),
        eq(outboundCommands.reference, `ORDER:${order.number}`),
      ),
    );
  const warnings = exported.length
    ? [
        `Order ${order.number} was already sent to the ERP (${exported.map((e) => e.status).join(', ')}); cancel it there too`,
      ]
    : [];
  const [updated] = await tx
    .update(orders)
    .set({
      status: 'cancelled',
      cancelledAt: now,
      cancelReason: actor.reason,
      expiresAt: null,
      ...(paid ? { paymentStatus: 'refund_due' as const, refundDueMinor: order.totalMinor } : {}),
      warnings: [...((order.warnings as string[]) ?? []), ...warnings],
      version: sql`${orders.version} + 1`,
      updatedAt: now,
    })
    .where(eq(orders.id, order.id))
    .returning();
  await addOrderEvent(tx, {
    tenantId: order.tenantId,
    orderId: order.id,
    type: actor.type ?? 'cancelled',
    fromStatus: order.status,
    toStatus: 'cancelled',
    actorUserId: actor.actorUserId,
    note: actor.reason,
    data: { releasedHolds: open.length, refundDueMinor: paid ? order.totalMinor.toString() : '0' },
    at: now,
  });
  await enqueueEvent(tx, {
    tenantId: order.tenantId,
    eventType: 'OrderCancelled',
    aggregateType: 'order',
    aggregateId: order.id,
    aggregateVersion: updated!.version,
    correlationId: actor.correlationId ?? null,
    payload: {
      orderId: order.id,
      number: order.number,
      reason: actor.reason,
      refundDueMinor: paid ? order.totalMinor.toString() : '0',
    },
  });
  return updated!;
}

/** Worker pass: unpaid orders past their payment window and unapproved orders past theirs are cancelled. */
export async function expireOrders(tx: Tx, now = new Date(), limit = 100): Promise<number> {
  const due = await tx
    .select()
    .from(orders)
    .where(
      and(
        inArray(orders.status, ['pending_payment', 'awaiting_approval', 'awaiting_buyer_approval']),
        lte(orders.expiresAt, now),
      ),
    )
    .orderBy(asc(orders.expiresAt))
    .limit(limit)
    .for('update', { skipLocked: true });
  for (const o of due)
    await cancelOrder(tx, o, {
      actorUserId: null,
      now,
      type: 'expired',
      reason: o.status === 'pending_payment' ? 'Payment window expired' : 'Approval window expired',
    });
  return due.length;
}

/** Worker pass: sent or accepted quotations past their validity become expired. */
export async function expireQuotations(tx: Tx, now = new Date()): Promise<number> {
  const expired = await tx
    .update(quotations)
    .set({ status: 'expired', updatedAt: now, version: sql`${quotations.version} + 1` })
    .where(and(inArray(quotations.status, ['sent', 'accepted']), lte(quotations.validUntil, now)))
    .returning({ id: quotations.id, tenantId: quotations.tenantId, number: quotations.number });
  for (const q of expired)
    await enqueueEvent(tx, {
      tenantId: q.tenantId,
      eventType: 'QuoteExpired',
      aggregateType: 'quotation',
      aggregateId: q.id,
      payload: { quotationId: q.id, number: q.number },
    });
  return expired.length;
}

/**
 * Stock committed to orders that this connection has already ACKNOWLEDGED (exported and accepted by the ERP) and
 * that we have not shipped yet. The ERP has already deducted these units, while our on-hand still contains them,
 * so ERP snapshots and reconciliation add them back instead of subtracting the same sale twice.
 * Key: `${variantId}:${locationId}` → quantity (decimal string).
 */
export async function acknowledgedCommitments(
  tx: Tx,
  tenantId: string,
  connectionId: string,
  variantIds: readonly string[],
): Promise<Map<string, string>> {
  if (!variantIds.length) return new Map();
  const rows = await tx.execute<{ variant_id: string; location_id: string; qty: string }>(sql`
    select r.variant_id, r.location_id, sum(r.quantity - r.fulfilled_quantity)::text as qty
      from reservations r
      join order_lines ol on ol.tenant_id = r.tenant_id and ol.reservation_id = r.id
      join orders o on o.id = ol.order_id
      join outbound_commands oc
        on oc.connection_id = ${connectionId} and oc.reference = 'ORDER:' || o.number and oc.status = 'acknowledged'
     where r.tenant_id = ${tenantId} and r.status = 'committed'
       and r.variant_id in (${sql.join(
         variantIds.map((v) => sql`${v}::uuid`),
         sql`, `,
       )})
     group by r.variant_id, r.location_id`);
  return new Map(rows.rows.map((r) => [`${r.variant_id}:${r.location_id}`, r.qty]));
}

/** Worker pass: submitted RFQs past the buyer's "needed by" date (never quoted) become expired. */
export async function expireRfqs(tx: Tx, now = new Date()): Promise<number> {
  const expired = await tx
    .update(rfqs)
    .set({ status: 'expired', updatedAt: now, version: sql`${rfqs.version} + 1` })
    .where(and(eq(rfqs.status, 'submitted'), lte(rfqs.neededBy, now)))
    .returning({ id: rfqs.id });
  return expired.length;
}
