import { qty, qtyAdd, qtyCmp, qtyNeg, qtySub } from '@uc/contracts';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from './client';
import { InventoryError, postMovements, setSerialState } from './inventory';
import { reservations } from './inventory-schema';
import { enqueueEvent } from './outbox';

/**
 * Phase 09 fulfilment stock steps (ADR-024). Shipping takes goods out of the building: on-hand and committed fall
 * together at the commitment's location, a piece becomes `shipped`, and the commitment records how much of it has
 * shipped (`fulfilled` once complete). A return brings goods back as sellable stock, or writes a piece off when
 * it is not restocked.
 */
export async function dispatchStock(
  tx: Tx,
  input: {
    tenantId: string;
    /** Shipment number (one stock document per dispatch). */
    reference: string;
    actorUserId: string | null;
    correlationId?: string | null;
    items: { reservationId: string; quantity: string }[];
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  const wanted = new Map<string, string>();
  for (const i of input.items)
    wanted.set(i.reservationId, qtyAdd(wanted.get(i.reservationId) ?? '0', i.quantity));
  const ids = [...wanted.keys()].sort();
  if (!ids.length) throw new InventoryError(422, 'VALIDATION_FAILED', 'Nothing to ship');
  // Lock in a stable order so concurrent dispatches of the same order cannot deadlock.
  const rows = await tx
    .select()
    .from(reservations)
    .where(and(eq(reservations.tenantId, input.tenantId), inArray(reservations.id, ids)))
    .orderBy(asc(reservations.id))
    .for('update');
  if (rows.length !== ids.length) throw new InventoryError(404, 'NOT_FOUND', 'Reservation not found');
  const lines = rows.map((r) => {
    const q = qty(wanted.get(r.id)!);
    const remaining = qtySub(r.quantity, r.fulfilledQuantity);
    if (r.status !== 'committed')
      throw new InventoryError(
        409,
        'INVALID_STATE_TRANSITION',
        `Only committed stock can ship (this is ${r.status})`,
      );
    if (qtyCmp(q, '0') <= 0 || qtyCmp(q, remaining) > 0)
      throw new InventoryError(
        409,
        'INSUFFICIENT_STOCK',
        `Only ${remaining} unit(s) of this line are left to ship`,
        {
          reservationId: r.id,
          remaining,
        },
      );
    return { r, q };
  });
  await postMovements(tx, {
    tenantId: input.tenantId,
    type: 'shipment',
    reference: input.reference,
    actorUserId: input.actorUserId,
    correlationId: input.correlationId ?? null,
    lines: lines.map(({ r, q }) => ({
      variantId: r.variantId,
      locationId: r.locationId,
      condition: 'sellable' as const,
      onHand: qtyNeg(q),
      committed: qtyNeg(q),
      serialItemId: r.serialItemId,
      reservationId: r.id,
    })),
  });
  const pieces = lines.filter(({ r }) => r.serialItemId).map(({ r }) => r.serialItemId!);
  await setSerialState(tx, input.tenantId, pieces, ['committed'], 'shipped');
  for (const { r, q } of lines) {
    const fulfilled = qtyAdd(r.fulfilledQuantity, q);
    const done = qtyCmp(fulfilled, r.quantity) === 0;
    const [updated] = await tx
      .update(reservations)
      .set({
        fulfilledQuantity: fulfilled,
        ...(done ? { status: 'fulfilled' as const, closedReason: 'shipped', closedAt: now } : {}),
        version: sql`${reservations.version} + 1`,
        updatedAt: now,
      })
      .where(eq(reservations.id, r.id))
      .returning();
    await enqueueEvent(tx, {
      tenantId: input.tenantId,
      eventType: 'ReservationFulfilled',
      aggregateType: 'reservation',
      aggregateId: r.id,
      aggregateVersion: updated!.version,
      correlationId: input.correlationId ?? null,
      payload: {
        reservationId: r.id,
        shippedQuantity: q,
        fulfilledQuantity: fulfilled,
        reference: input.reference,
      },
    });
  }
}

/** Receives returned goods: restock as sellable at `locationId`, or (not restocked) write returned pieces off. */
export async function receiveReturnStock(
  tx: Tx,
  input: {
    tenantId: string;
    /** Return number (one stock document per receipt). */
    reference: string;
    actorUserId: string | null;
    correlationId?: string | null;
    restock: boolean;
    locationId: string;
    items: { variantId: string; serialItemId: string | null; quantity: string }[];
  },
): Promise<void> {
  const pieces = input.items.filter((i) => i.serialItemId).map((i) => i.serialItemId!);
  if (!input.restock) {
    // Not back in stock: nothing is added to on-hand; returned pieces leave the inventory for good.
    await setSerialState(tx, input.tenantId, pieces, ['shipped'], 'written_off', null);
    return;
  }
  await postMovements(tx, {
    tenantId: input.tenantId,
    type: 'return_receive',
    reference: input.reference,
    actorUserId: input.actorUserId,
    correlationId: input.correlationId ?? null,
    lines: input.items.map((i) => ({
      variantId: i.variantId,
      locationId: input.locationId,
      condition: 'sellable' as const,
      onHand: qty(i.quantity),
      serialItemId: i.serialItemId,
    })),
  });
  await setSerialState(tx, input.tenantId, pieces, ['shipped'], 'in_stock', input.locationId);
}
