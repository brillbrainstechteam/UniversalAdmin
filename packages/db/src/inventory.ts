import { randomUUID } from 'node:crypto';
import {
  qty,
  qtyAdd,
  qtyCmp,
  qtyIsZero,
  qtyMax0,
  qtyNeg,
  qtyProblem,
  qtySub,
  type ErrorCode,
  type StockUnit,
} from '@uc/contracts';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Tx } from './client';
import {
  channelStockLocations,
  reservations,
  stockBalances,
  stockDocuments,
  stockMovements,
  stockSettings,
  variantStockSettings,
  type MOVEMENT_TYPES,
  type reconciliationIssues,
  type STOCK_CONDITIONS,
} from './inventory-schema';
import { serialItems } from './jewellery-schema';
import { enqueueEvent } from './outbox';
import { locations } from './schema';

/**
 * Phase 04 inventory engine (ADR-018). Every stock change is an append-only movement plus a balance update in
 * the SAME transaction; balance rows are locked in one global order (variant, location, condition) and checked
 * before the update, with database CHECK constraints as the last line of defence against oversell.
 */

export type StockCondition = (typeof STOCK_CONDITIONS)[number];
export type MovementType = (typeof MOVEMENT_TYPES)[number];
export type ReservationRow = typeof reservations.$inferSelect;
export type MovementRow = typeof stockMovements.$inferSelect;

export class InventoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const invalid = (path: string, message: string) =>
  new InventoryError(400, 'VALIDATION_FAILED', message, [{ path, message }]);

// ---------------------------------------------------------------- profile

export interface StockProfile {
  tracking: 'quantity' | 'serial';
  unit: StockUnit;
  buffer: string;
  lowStockThreshold: string;
  ttlMinutes: number;
  hasSettingsRow: boolean;
  version: number;
}

export async function loadStockProfile(tx: Tx, tenantId: string, variantId: string): Promise<StockProfile> {
  const [tenant] = await tx.select().from(stockSettings).where(eq(stockSettings.tenantId, tenantId));
  const [own] = await tx
    .select()
    .from(variantStockSettings)
    .where(and(eq(variantStockSettings.tenantId, tenantId), eq(variantStockSettings.variantId, variantId)));
  return {
    tracking: own?.tracking ?? 'quantity',
    unit: own?.unit ?? 'pcs',
    buffer: own?.buffer ?? tenant?.defaultBuffer ?? '0',
    lowStockThreshold: own?.lowStockThreshold ?? tenant?.lowStockThreshold ?? '1',
    ttlMinutes: tenant?.reservationTtlMinutes ?? 15,
    hasSettingsRow: own !== undefined,
    version: own?.version ?? 0,
  };
}

export function assertQuantity(
  path: string,
  value: string,
  unit: StockUnit,
  options?: { signed?: boolean; allowZero?: boolean },
) {
  const problem = qtyProblem(value, unit, options);
  if (problem) throw invalid(path, problem);
}

// ---------------------------------------------------------------- ledger posting

export interface MovementLine {
  variantId: string;
  locationId: string;
  condition: StockCondition;
  onHand?: string;
  reserved?: string;
  committed?: string;
  serialItemId?: string | null;
  reservationId?: string | null;
  /** Shown in INSUFFICIENT_STOCK details. */
  label?: string;
}

export interface PostInput {
  tenantId: string;
  type: MovementType;
  lines: MovementLine[];
  actorUserId: string | null;
  operationId?: string;
  reference?: string | null;
  reasonCode?: string | null;
  note?: string | null;
  correlationId?: string | null;
  /** Business operations record a stock document (unique reference per type); reservation steps do not. */
  document?: boolean;
  /** Emit InventoryMovementRecorded (default true). */
  event?: boolean;
}

const lineKey = (l: { variantId: string; locationId: string; condition: string }) =>
  `${l.variantId}|${l.locationId}|${l.condition}`;

/**
 * Posts one operation: optional stock document, balance updates (locked in global key order, validated) and
 * one ledger row per line. Throws INSUFFICIENT_STOCK when a balance would go negative or below its
 * reservations; the whole transaction then rolls back.
 */
export async function postMovements(tx: Tx, input: PostInput): Promise<MovementRow[]> {
  const operationId = input.operationId ?? randomUUID();
  const reference = input.reference ?? null;
  if (input.document ?? true) {
    const inserted = await tx
      .insert(stockDocuments)
      .values({
        id: operationId,
        tenantId: input.tenantId,
        type: input.type,
        reference,
        actorUserId: input.actorUserId,
      })
      .onConflictDoNothing()
      .returning({ id: stockDocuments.id });
    if (inserted.length === 0) {
      throw new InventoryError(
        409,
        'DUPLICATE',
        `Reference "${reference}" was already posted as a ${input.type}`,
        {
          field: 'reference',
        },
      );
    }
  }

  // Aggregate deltas per balance key, then apply in a deterministic order (deadlock-free).
  const totals = new Map<string, MovementLine & { onHand: string; reserved: string; committed: string }>();
  for (const l of input.lines) {
    const key = lineKey(l);
    const prev = totals.get(key);
    totals.set(key, {
      ...l,
      onHand: qtyAdd(prev?.onHand ?? '0', l.onHand ?? '0'),
      reserved: qtyAdd(prev?.reserved ?? '0', l.reserved ?? '0'),
      committed: qtyAdd(prev?.committed ?? '0', l.committed ?? '0'),
    });
  }
  const shortages: Record<string, string>[] = [];
  for (const key of [...totals.keys()].sort()) {
    const t = totals.get(key)!;
    if (qtyIsZero(t.onHand) && qtyIsZero(t.reserved) && qtyIsZero(t.committed)) continue;
    await tx
      .insert(stockBalances)
      .values({
        tenantId: input.tenantId,
        variantId: t.variantId,
        locationId: t.locationId,
        condition: t.condition,
      })
      .onConflictDoNothing();
    const where = and(
      eq(stockBalances.tenantId, input.tenantId),
      eq(stockBalances.variantId, t.variantId),
      eq(stockBalances.locationId, t.locationId),
      eq(stockBalances.condition, t.condition),
    );
    const [bal] = await tx.select().from(stockBalances).where(where).for('update');
    if (!bal) throw new Error('balance row missing after upsert');
    const onHand = qtyAdd(bal.onHand, t.onHand);
    const reserved = qtyAdd(bal.reserved, t.reserved);
    const committed = qtyAdd(bal.committed, t.committed);
    const holdsOutsideSellable =
      t.condition !== 'sellable' && (!qtyIsZero(reserved) || !qtyIsZero(committed));
    if (
      qtyCmp(onHand, '0') < 0 ||
      qtyCmp(reserved, '0') < 0 ||
      qtyCmp(committed, '0') < 0 ||
      qtyCmp(onHand, qtyAdd(reserved, committed)) < 0 ||
      holdsOutsideSellable
    ) {
      shortages.push({
        variantId: t.variantId,
        locationId: t.locationId,
        condition: t.condition,
        ...(t.label ? { item: t.label } : {}),
        onHand: bal.onHand,
        reserved: bal.reserved,
        committed: bal.committed,
        available: qtyMax0(qtySub(bal.onHand, qtyAdd(bal.reserved, bal.committed))),
        requestedChange: t.onHand,
      });
      continue;
    }
    await tx
      .update(stockBalances)
      .set({
        onHand: sql`${stockBalances.onHand} + ${t.onHand}::numeric`,
        reserved: sql`${stockBalances.reserved} + ${t.reserved}::numeric`,
        committed: sql`${stockBalances.committed} + ${t.committed}::numeric`,
        version: sql`${stockBalances.version} + 1`,
        updatedAt: new Date(),
      })
      .where(where);
  }
  if (shortages.length) {
    throw new InventoryError(
      409,
      'INSUFFICIENT_STOCK',
      'Not enough stock: quantities cannot go below zero or below what is reserved/committed',
      { shortages },
    );
  }

  const rows = input.lines
    .filter(
      (l) => !(qtyIsZero(l.onHand ?? '0') && qtyIsZero(l.reserved ?? '0') && qtyIsZero(l.committed ?? '0')),
    )
    .map((l) => ({
      tenantId: input.tenantId,
      variantId: l.variantId,
      locationId: l.locationId,
      condition: l.condition,
      serialItemId: l.serialItemId ?? null,
      type: input.type,
      onHandDelta: qty(l.onHand ?? '0'),
      reservedDelta: qty(l.reserved ?? '0'),
      committedDelta: qty(l.committed ?? '0'),
      reasonCode: input.reasonCode ?? null,
      note: input.note ?? null,
      reference,
      operationId,
      reservationId: l.reservationId ?? null,
      actorUserId: input.actorUserId,
    }));
  const movements = rows.length ? await tx.insert(stockMovements).values(rows).returning() : [];
  if ((input.event ?? true) && movements.length) {
    await enqueueEvent(tx, {
      tenantId: input.tenantId,
      eventType: 'InventoryMovementRecorded',
      aggregateType: 'stock_operation',
      aggregateId: operationId,
      correlationId: input.correlationId ?? null,
      payload: {
        operationId,
        type: input.type,
        reference,
        lines: movements.map((m) => ({
          variantId: m.variantId,
          locationId: m.locationId,
          condition: m.condition,
          serialItemId: m.serialItemId,
          onHandDelta: m.onHandDelta,
          reservedDelta: m.reservedDelta,
          committedDelta: m.committedDelta,
        })),
      },
    });
  }
  return movements;
}

/** Moves serialized pieces between stock states; every piece must currently be in one of `from`. */
export async function setSerialState(
  tx: Tx,
  tenantId: string,
  ids: readonly string[],
  from: readonly string[],
  to: 'in_stock' | 'reserved' | 'committed' | 'in_transit' | 'written_off',
  locationId?: string | null,
): Promise<void> {
  if (!ids.length) return;
  const updated = await tx
    .update(serialItems)
    .set({
      stockState: to,
      ...(locationId !== undefined ? { locationId } : {}),
      version: sql`${serialItems.version} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(serialItems.tenantId, tenantId),
        inArray(serialItems.id, [...ids]),
        inArray(serialItems.stockState, [...from] as (typeof serialItems.$inferSelect)['stockState'][]),
      ),
    )
    .returning({ id: serialItems.id });
  if (updated.length !== new Set(ids).size) {
    throw new InventoryError(409, 'INVALID_STATE_TRANSITION', `A piece is no longer ${from.join(' or ')}`, {
      expected: from,
    });
  }
}

// ---------------------------------------------------------------- reservations

export interface ReserveInput {
  tenantId: string;
  variantId: string;
  quantity: string;
  locationId?: string;
  serialItemId?: string;
  channelId?: string;
  referenceType: 'manual' | 'cart' | 'checkout' | 'order' | 'quote';
  referenceId?: string | null;
  ttlMinutes?: number;
  note?: string | null;
  idempotencyKey: string;
  actorUserId: string | null;
  correlationId?: string | null;
  /** Membership location scope (null = all locations). */
  allowedLocationIds: readonly string[] | null;
  now?: Date;
}

/** Locations whose sellable stock counts for a hold: active, in the channel's set (if any), in scope. */
async function eligibleLocations(
  tx: Tx,
  tenantId: string,
  channelId: string | undefined,
  allowed: readonly string[] | null,
): Promise<Set<string>> {
  const active = await tx
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.tenantId, tenantId), eq(locations.status, 'active')));
  let ids = active.map((l) => l.id);
  if (channelId) {
    const configured = await tx
      .select({ id: channelStockLocations.locationId })
      .from(channelStockLocations)
      .where(
        and(eq(channelStockLocations.tenantId, tenantId), eq(channelStockLocations.channelId, channelId)),
      );
    if (configured.length) {
      const set = new Set(configured.map((c) => c.id));
      ids = ids.filter((id) => set.has(id));
    }
  }
  if (allowed) {
    const set = new Set(allowed);
    ids = ids.filter((id) => set.has(id));
  }
  return new Set(ids);
}

function sameRequest(r: ReservationRow, input: ReserveInput): boolean {
  return (
    r.variantId === input.variantId &&
    qtyCmp(r.quantity, input.quantity) === 0 &&
    (input.locationId === undefined || r.locationId === input.locationId) &&
    (r.serialItemId ?? undefined) === input.serialItemId &&
    (r.channelId ?? undefined) === input.channelId
  );
}

export async function findReservationByKey(tx: Tx, tenantId: string, key: string) {
  const [row] = await tx
    .select()
    .from(reservations)
    .where(and(eq(reservations.tenantId, tenantId), eq(reservations.idempotencyKey, key)));
  return row;
}

/**
 * Check-and-reserve under row locks: expire due holds of the variant, lock its sellable balances, check ATP
 * (minus buffer) and the chosen location, then post the hold. Exactly one of N concurrent requests for the last
 * unit (or the same piece) succeeds.
 */
export async function reserveStock(
  tx: Tx,
  input: ReserveInput,
): Promise<{ reservation: ReservationRow; replayed: boolean }> {
  const now = input.now ?? new Date();
  const existing = await findReservationByKey(tx, input.tenantId, input.idempotencyKey);
  if (existing) {
    if (!sameRequest(existing, input)) {
      throw new InventoryError(
        422,
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key was already used for a different hold',
      );
    }
    return { reservation: existing, replayed: true };
  }

  const profile = await loadStockProfile(tx, input.tenantId, input.variantId);
  assertQuantity('quantity', input.quantity, profile.unit);
  if (profile.tracking === 'serial') {
    if (!input.serialItemId)
      throw invalid('serialItemId', 'This variant is tracked by piece: choose the exact piece to hold');
    if (qtyCmp(input.quantity, '1') !== 0) throw invalid('quantity', 'A piece hold is always quantity 1');
  } else if (input.serialItemId) {
    throw invalid('serialItemId', 'This variant is tracked by quantity, not by piece');
  }

  await expireReservations(tx, { tenantId: input.tenantId, variantId: input.variantId, now });

  const eligible = await eligibleLocations(tx, input.tenantId, input.channelId, input.allowedLocationIds);
  if (input.locationId && !eligible.has(input.locationId)) {
    if (input.allowedLocationIds && !input.allowedLocationIds.includes(input.locationId)) {
      throw new InventoryError(403, 'LOCATION_OUT_OF_SCOPE', 'You cannot hold stock at this location');
    }
    throw invalid('locationId', 'Location is inactive or does not feed this channel');
  }

  // Lock every sellable balance of the variant in global key order.
  const balances = await tx
    .select()
    .from(stockBalances)
    .where(
      and(
        eq(stockBalances.tenantId, input.tenantId),
        eq(stockBalances.variantId, input.variantId),
        eq(stockBalances.condition, 'sellable'),
      ),
    )
    .orderBy(asc(stockBalances.locationId))
    .for('update');
  const availableAt = new Map(
    balances
      .filter((b) => eligible.has(b.locationId))
      .map((b) => [b.locationId, qtySub(b.onHand, qtyAdd(b.reserved, b.committed))] as const),
  );

  let locationId: string;
  if (profile.tracking === 'serial') {
    const [piece] = await tx
      .select()
      .from(serialItems)
      .where(and(eq(serialItems.tenantId, input.tenantId), eq(serialItems.id, input.serialItemId!)))
      .for('update');
    if (!piece || piece.variantId !== input.variantId)
      throw new InventoryError(404, 'NOT_FOUND', 'Piece not found for this variant');
    if (piece.status !== 'active' || piece.stockState !== 'in_stock' || !piece.locationId) {
      throw new InventoryError(
        409,
        'INSUFFICIENT_STOCK',
        `Piece ${piece.serialTag} is not available (${piece.stockState})`,
        {
          stockState: piece.stockState,
        },
      );
    }
    if (!eligible.has(piece.locationId) || (input.locationId && input.locationId !== piece.locationId)) {
      throw new InventoryError(
        409,
        'INSUFFICIENT_STOCK',
        `Piece ${piece.serialTag} is not at an eligible location`,
      );
    }
    locationId = piece.locationId;
  } else {
    const total = [...availableAt.values()].reduce((acc, v) => qtyAdd(acc, qtyMax0(v)), '0');
    const atp = qtyMax0(qtySub(total, profile.buffer));
    if (qtyCmp(input.quantity, atp) > 0) {
      throw new InventoryError(409, 'INSUFFICIENT_STOCK', `Only ${atp} available to promise`, {
        available: total,
        buffer: profile.buffer,
        atp,
        requested: input.quantity,
      });
    }
    const candidates = [...availableAt.entries()]
      .filter(([id, v]) => (!input.locationId || id === input.locationId) && qtyCmp(v, input.quantity) >= 0)
      .sort((a, b) => qtyCmp(b[1], a[1]) || a[0].localeCompare(b[0]));
    if (!candidates.length) {
      throw new InventoryError(
        409,
        'INSUFFICIENT_STOCK',
        input.locationId
          ? 'Not enough available stock at this location'
          : 'No single location has enough available stock for this hold',
        { requested: input.quantity, byLocation: Object.fromEntries(availableAt) },
      );
    }
    locationId = candidates[0]![0];
  }

  const id = randomUUID();
  const ttl = input.ttlMinutes ?? profile.ttlMinutes;
  const [reservation] = await tx
    .insert(reservations)
    .values({
      id,
      tenantId: input.tenantId,
      variantId: input.variantId,
      locationId,
      serialItemId: input.serialItemId ?? null,
      channelId: input.channelId ?? null,
      quantity: qty(input.quantity),
      status: 'held',
      referenceType: input.referenceType,
      referenceId: input.referenceId ?? null,
      idempotencyKey: input.idempotencyKey,
      expiresAt: new Date(now.getTime() + ttl * 60_000),
      note: input.note ?? null,
      createdBy: input.actorUserId,
    })
    .returning();
  await postMovements(tx, {
    tenantId: input.tenantId,
    type: 'reservation_hold',
    operationId: id,
    actorUserId: input.actorUserId,
    document: false,
    event: false,
    lines: [
      {
        variantId: input.variantId,
        locationId,
        condition: 'sellable',
        reserved: input.quantity,
        serialItemId: input.serialItemId ?? null,
        reservationId: id,
      },
    ],
  });
  if (input.serialItemId)
    await setSerialState(tx, input.tenantId, [input.serialItemId], ['in_stock'], 'reserved');
  await enqueueEvent(tx, {
    tenantId: input.tenantId,
    eventType: 'ReservationCreated',
    aggregateType: 'reservation',
    aggregateId: id,
    correlationId: input.correlationId ?? null,
    payload: reservationPayload(reservation!),
  });
  return { reservation: reservation!, replayed: false };
}

function reservationPayload(r: ReservationRow): Record<string, unknown> {
  return {
    reservationId: r.id,
    variantId: r.variantId,
    locationId: r.locationId,
    serialItemId: r.serialItemId,
    channelId: r.channelId,
    quantity: r.quantity,
    status: r.status,
    referenceType: r.referenceType,
    referenceId: r.referenceId,
    expiresAt: r.expiresAt?.toISOString() ?? null,
  };
}

async function lockReservation(tx: Tx, tenantId: string, id: string): Promise<ReservationRow> {
  const [row] = await tx
    .select()
    .from(reservations)
    .where(and(eq(reservations.tenantId, tenantId), eq(reservations.id, id)))
    .for('update');
  if (!row) throw new InventoryError(404, 'NOT_FOUND', 'Reservation not found');
  return row;
}

export interface ReservationAction {
  tenantId: string;
  reservationId: string;
  actorUserId: string | null;
  correlationId?: string | null;
  now?: Date;
}

/** held → committed. An expired hold cannot be committed (the checkout must re-reserve). */
export async function commitReservation(tx: Tx, input: ReservationAction): Promise<ReservationRow> {
  const now = input.now ?? new Date();
  const r = await lockReservation(tx, input.tenantId, input.reservationId);
  if (r.status !== 'held') {
    throw new InventoryError(409, 'INVALID_STATE_TRANSITION', `Cannot commit a ${r.status} reservation`, {
      status: r.status,
    });
  }
  if (r.expiresAt && r.expiresAt.getTime() <= now.getTime()) {
    throw new InventoryError(409, 'RESERVATION_EXPIRED', 'This hold has expired; reserve the stock again');
  }
  await postMovements(tx, {
    tenantId: input.tenantId,
    type: 'reservation_commit',
    actorUserId: input.actorUserId,
    document: false,
    event: false,
    lines: [
      {
        variantId: r.variantId,
        locationId: r.locationId,
        condition: 'sellable',
        reserved: qtyNeg(r.quantity),
        committed: r.quantity,
        serialItemId: r.serialItemId,
        reservationId: r.id,
      },
    ],
  });
  if (r.serialItemId) await setSerialState(tx, input.tenantId, [r.serialItemId], ['reserved'], 'committed');
  const [updated] = await tx
    .update(reservations)
    .set({ status: 'committed', version: sql`${reservations.version} + 1`, updatedAt: now })
    .where(eq(reservations.id, r.id))
    .returning();
  await enqueueEvent(tx, {
    tenantId: input.tenantId,
    eventType: 'ReservationCommitted',
    aggregateType: 'reservation',
    aggregateId: r.id,
    aggregateVersion: updated!.version,
    correlationId: input.correlationId ?? null,
    payload: reservationPayload(updated!),
  });
  return updated!;
}

/** held → released, or committed → released (returns committed stock to available). */
export async function releaseReservation(
  tx: Tx,
  input: ReservationAction & { reason?: string | null },
): Promise<ReservationRow> {
  const now = input.now ?? new Date();
  const r = await lockReservation(tx, input.tenantId, input.reservationId);
  if (r.status !== 'held' && r.status !== 'committed') {
    throw new InventoryError(409, 'INVALID_STATE_TRANSITION', `Reservation is already ${r.status}`, {
      status: r.status,
    });
  }
  if (r.status === 'committed' && !input.reason) {
    throw invalid('reason', 'Give a reason to release committed stock');
  }
  const wasHeld = r.status === 'held';
  await postMovements(tx, {
    tenantId: input.tenantId,
    type: wasHeld ? 'reservation_release' : 'commitment_release',
    actorUserId: input.actorUserId,
    note: input.reason ?? null,
    document: false,
    event: false,
    lines: [
      {
        variantId: r.variantId,
        locationId: r.locationId,
        condition: 'sellable',
        ...(wasHeld ? { reserved: qtyNeg(r.quantity) } : { committed: qtyNeg(r.quantity) }),
        serialItemId: r.serialItemId,
        reservationId: r.id,
      },
    ],
  });
  if (r.serialItemId) {
    await setSerialState(
      tx,
      input.tenantId,
      [r.serialItemId],
      [wasHeld ? 'reserved' : 'committed'],
      'in_stock',
    );
  }
  const [updated] = await tx
    .update(reservations)
    .set({
      status: 'released',
      closedReason: input.reason ?? 'released',
      closedAt: now,
      version: sql`${reservations.version} + 1`,
      updatedAt: now,
    })
    .where(eq(reservations.id, r.id))
    .returning();
  await enqueueEvent(tx, {
    tenantId: input.tenantId,
    eventType: 'ReservationReleased',
    aggregateType: 'reservation',
    aggregateId: r.id,
    aggregateVersion: updated!.version,
    correlationId: input.correlationId ?? null,
    payload: { ...reservationPayload(updated!), previousStatus: r.status },
  });
  return updated!;
}

/**
 * Expires due holds (status held, expires_at ≤ now). Idempotent: rows are claimed with SKIP LOCKED and the
 * status is re-checked, so the worker and inline expiry never double-release. Works in a tenant transaction
 * (one tenant, optionally one variant) or a system transaction (all tenants).
 */
export async function expireReservations(
  tx: Tx,
  filter: { tenantId?: string; variantId?: string; now?: Date; limit?: number },
): Promise<number> {
  const now = filter.now ?? new Date();
  const due = await tx
    .select()
    .from(reservations)
    .where(
      and(
        eq(reservations.status, 'held'),
        lte(reservations.expiresAt, now),
        filter.tenantId ? eq(reservations.tenantId, filter.tenantId) : undefined,
        filter.variantId ? eq(reservations.variantId, filter.variantId) : undefined,
      ),
    )
    .orderBy(asc(reservations.id))
    .limit(filter.limit ?? 500)
    .for('update', { skipLocked: true });
  for (const r of due) {
    await postMovements(tx, {
      tenantId: r.tenantId,
      type: 'reservation_expire',
      actorUserId: null,
      document: false,
      event: false,
      lines: [
        {
          variantId: r.variantId,
          locationId: r.locationId,
          condition: 'sellable',
          reserved: qtyNeg(r.quantity),
          serialItemId: r.serialItemId,
          reservationId: r.id,
        },
      ],
    });
    if (r.serialItemId) await setSerialState(tx, r.tenantId, [r.serialItemId], ['reserved'], 'in_stock');
    const [updated] = await tx
      .update(reservations)
      .set({
        status: 'expired',
        closedReason: 'ttl',
        closedAt: now,
        version: sql`${reservations.version} + 1`,
        updatedAt: now,
      })
      .where(eq(reservations.id, r.id))
      .returning();
    await enqueueEvent(tx, {
      tenantId: r.tenantId,
      eventType: 'ReservationExpired',
      aggregateType: 'reservation',
      aggregateId: r.id,
      aggregateVersion: updated!.version,
      payload: reservationPayload(updated!),
    });
  }
  return due.length;
}

// ---------------------------------------------------------------- reconciliation

export type IssueKind = (typeof reconciliationIssues.$inferSelect)['kind'];

/** Opens an issue unless one with the same dedupe key is still open. Returns the new id (or null). */
export async function openIssue(
  tx: Tx,
  input: {
    tenantId: string;
    kind: IssueKind;
    severity: 'info' | 'warning' | 'critical';
    variantId?: string | null;
    locationId?: string | null;
    details: Record<string, unknown>;
    dedupeKey: string;
    correlationId?: string | null;
  },
): Promise<string | null> {
  const inserted = await tx.execute<{ id: string }>(sql`
    insert into reconciliation_issues (tenant_id, domain, kind, severity, variant_id, location_id, details, dedupe_key)
    values (${input.tenantId}, 'inventory', ${input.kind}, ${input.severity}, ${input.variantId ?? null},
            ${input.locationId ?? null}, ${JSON.stringify(input.details)}::jsonb, ${input.dedupeKey})
    on conflict (tenant_id, dedupe_key) where status = 'open' do nothing
    returning id`);
  const id = inserted.rows[0]?.id ?? null;
  if (id) {
    await enqueueEvent(tx, {
      tenantId: input.tenantId,
      eventType: 'ReconciliationIssueOpened',
      aggregateType: 'reconciliation_issue',
      aggregateId: id,
      correlationId: input.correlationId ?? null,
      payload: {
        issueId: id,
        domain: 'inventory',
        kind: input.kind,
        variantId: input.variantId ?? null,
        locationId: input.locationId ?? null,
        details: input.details,
      },
    });
  }
  return id;
}

export interface ReconcileResult {
  checked: number;
  mismatches: number;
  issuesOpened: number;
}

interface Mismatch {
  tenant_id: string;
  variant_id: string;
  location_id: string;
  condition: string;
  [k: string]: unknown;
}

/**
 * Compares balances with (1) the ledger sum, (2) open reservations and (3) serialized pieces. Each mismatch opens
 * one reconciliation issue (deduplicated while open). Balances are never silently "fixed": a person resolves.
 */
export async function reconcileInventory(
  tx: Tx,
  filter: { tenantId?: string } = {},
): Promise<ReconcileResult> {
  const t = filter.tenantId ?? null;
  const tenantCond = (col: string) => (t ? sql`${sql.raw(col)} = ${t}::uuid` : sql`true`);

  const ledger = await tx.execute<Mismatch>(sql`
    with l as (
      select m.tenant_id, m.variant_id, m.location_id, m.condition,
             sum(m.on_hand_delta) as oh, sum(m.reserved_delta) as r, sum(m.committed_delta) as c
      from stock_movements m where ${tenantCond('m.tenant_id')} group by 1, 2, 3, 4
    ), b as (select * from stock_balances sb where ${tenantCond('sb.tenant_id')})
    select coalesce(b.tenant_id, l.tenant_id) as tenant_id, coalesce(b.variant_id, l.variant_id) as variant_id,
           coalesce(b.location_id, l.location_id) as location_id, coalesce(b.condition, l.condition) as condition,
           coalesce(b.on_hand, 0) as balance_on_hand, coalesce(l.oh, 0) as ledger_on_hand,
           coalesce(b.reserved, 0) as balance_reserved, coalesce(l.r, 0) as ledger_reserved,
           coalesce(b.committed, 0) as balance_committed, coalesce(l.c, 0) as ledger_committed
    from b full join l on b.tenant_id = l.tenant_id and b.variant_id = l.variant_id
      and b.location_id = l.location_id and b.condition = l.condition
    where coalesce(b.on_hand, 0) <> coalesce(l.oh, 0) or coalesce(b.reserved, 0) <> coalesce(l.r, 0)
       or coalesce(b.committed, 0) <> coalesce(l.c, 0)`);

  const holds = await tx.execute<Mismatch>(sql`
    with r as (
      select rs.tenant_id, rs.variant_id, rs.location_id,
             coalesce(sum(rs.quantity) filter (where rs.status = 'held'), 0) as held,
             coalesce(sum(rs.quantity) filter (where rs.status = 'committed'), 0) as com
      from reservations rs where rs.status in ('held', 'committed') and ${tenantCond('rs.tenant_id')} group by 1, 2, 3
    ), b as (select * from stock_balances sb where sb.condition = 'sellable' and ${tenantCond('sb.tenant_id')})
    select coalesce(b.tenant_id, r.tenant_id) as tenant_id, coalesce(b.variant_id, r.variant_id) as variant_id,
           coalesce(b.location_id, r.location_id) as location_id, 'sellable' as condition,
           coalesce(b.reserved, 0) as balance_reserved, coalesce(r.held, 0) as held_reservations,
           coalesce(b.committed, 0) as balance_committed, coalesce(r.com, 0) as committed_reservations
    from b full join r on b.tenant_id = r.tenant_id and b.variant_id = r.variant_id and b.location_id = r.location_id
    where coalesce(b.reserved, 0) <> coalesce(r.held, 0) or coalesce(b.committed, 0) <> coalesce(r.com, 0)`);

  const pieces = await tx.execute<Mismatch>(sql`
    with p as (
      select s.tenant_id, s.variant_id, s.location_id,
             case when s.stock_state = 'in_transit' then 'in_transit' else 'sellable' end as condition,
             count(*)::numeric as on_hand,
             (count(*) filter (where s.stock_state = 'reserved'))::numeric as reserved,
             (count(*) filter (where s.stock_state = 'committed'))::numeric as committed
      from serial_items s
      join variant_stock_settings vs on vs.tenant_id = s.tenant_id and vs.variant_id = s.variant_id and vs.tracking = 'serial'
      where s.stock_state in ('in_stock', 'reserved', 'committed', 'in_transit') and ${tenantCond('s.tenant_id')}
      group by 1, 2, 3, 4
    ), b as (
      select sb.* from stock_balances sb
      join variant_stock_settings vs on vs.tenant_id = sb.tenant_id and vs.variant_id = sb.variant_id and vs.tracking = 'serial'
      where ${tenantCond('sb.tenant_id')}
    )
    select coalesce(b.tenant_id, p.tenant_id) as tenant_id, coalesce(b.variant_id, p.variant_id) as variant_id,
           coalesce(b.location_id, p.location_id) as location_id, coalesce(b.condition, p.condition) as condition,
           coalesce(b.on_hand, 0) as balance_on_hand, coalesce(p.on_hand, 0) as pieces_on_hand,
           coalesce(b.reserved, 0) as balance_reserved, coalesce(p.reserved, 0) as pieces_reserved,
           coalesce(b.committed, 0) as balance_committed, coalesce(p.committed, 0) as pieces_committed
    from b full join p on b.tenant_id = p.tenant_id and b.variant_id = p.variant_id
      and b.location_id = p.location_id and b.condition = p.condition
    where coalesce(b.on_hand, 0) <> coalesce(p.on_hand, 0) or coalesce(b.reserved, 0) <> coalesce(p.reserved, 0)
       or coalesce(b.committed, 0) <> coalesce(p.committed, 0)`);

  const counted = await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from stock_balances sb where ${tenantCond('sb.tenant_id')}`,
  );

  const findings: { kind: string; check: string; severity: string; row: Mismatch }[] = [
    ...ledger.rows.map((row) => ({
      kind: 'ledger_balance_mismatch',
      check: 'ledger',
      severity: 'critical',
      row,
    })),
    ...holds.rows.map((row) => ({
      kind: 'ledger_balance_mismatch',
      check: 'reservations',
      severity: 'critical',
      row,
    })),
    ...pieces.rows.map((row) => ({
      kind: 'serial_state_mismatch',
      check: 'pieces',
      severity: 'warning',
      row,
    })),
  ];
  let opened = 0;
  for (const f of findings) {
    const { tenant_id, variant_id, location_id, condition, ...values } = f.row;
    const details = { check: f.check, condition, ...values };
    const issueId = await openIssue(tx, {
      tenantId: tenant_id,
      kind: f.kind as IssueKind,
      severity: f.severity as 'warning' | 'critical',
      variantId: variant_id,
      locationId: location_id,
      details,
      dedupeKey: `${f.check}:${variant_id}:${location_id}:${condition}`,
    });
    if (issueId) opened++;
  }
  return { checked: counted.rows[0]?.n ?? 0, mismatches: findings.length, issuesOpened: opened };
}
