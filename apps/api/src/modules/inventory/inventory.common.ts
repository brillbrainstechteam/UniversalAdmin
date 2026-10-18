import type { ReconciliationIssue, Reservation, StockMovement, Transfer } from '@uc/contracts';
import { qty } from '@uc/contracts';
import {
  locations,
  reconciliationIssues,
  reservations,
  serialItems,
  stockMovements,
  transferLines,
  transfers,
  users,
  variants,
  products,
  type Tx,
} from '@uc/db';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AppError, Errors } from '../../common/errors';
import { iso } from '../../common/mappers';
import type { TenantState } from '../../common/request';

export const NO_LOCATION = '00000000-0000-0000-0000-000000000000';

export function requireInventory(ctx: TenantState): void {
  if (!ctx.features.includes('inventory')) throw Errors.featureNotEntitled('inventory');
}

export function inScope(ctx: TenantState, locationId: string): boolean {
  return ctx.locationScope === null || ctx.locationScope.includes(locationId);
}

export function assertScope(ctx: TenantState, locationId: string): void {
  if (!inScope(ctx, locationId)) {
    throw new AppError(403, 'LOCATION_OUT_OF_SCOPE', 'This location is outside your location scope');
  }
}

/** SQL filter restricting a location column to the member's scope (undefined = unrestricted). */
export function scopeFilter(ctx: TenantState, column: Parameters<typeof eq>[0]): SQL | undefined {
  if (ctx.locationScope === null) return undefined;
  return inArray(column, ctx.locationScope.length ? [...ctx.locationScope] : [NO_LOCATION]);
}

/** Loads an active, in-scope location of this tenant. */
export async function usableLocation(tx: Tx, ctx: TenantState, locationId: string, path = 'locationId') {
  const [loc] = await tx
    .select()
    .from(locations)
    .where(and(eq(locations.tenantId, ctx.tenantId), eq(locations.id, locationId)));
  if (!loc) throw Errors.validation([{ path, message: 'Unknown location' }]);
  assertScope(ctx, loc.id);
  if (loc.status !== 'active')
    throw Errors.validation([{ path, message: `Location ${loc.name} is inactive` }]);
  return loc;
}

export const locRef = (l: { id: string; code: string; name: string }) => ({
  id: l.id,
  code: l.code,
  name: l.name,
});

// ---------------------------------------------------------------- movements

export async function loadMovements(
  tx: Tx,
  where: (SQL | undefined)[],
  options: { limit?: number; order?: 'asc' | 'desc' } = {},
): Promise<StockMovement[]> {
  const order = options.order ?? 'desc';
  const rows = await tx
    .select({
      m: stockMovements,
      sku: variants.sku,
      loc: { id: locations.id, code: locations.code, name: locations.name },
      serialTag: serialItems.serialTag,
      actorName: users.displayName,
    })
    .from(stockMovements)
    .innerJoin(variants, eq(variants.id, stockMovements.variantId))
    .innerJoin(locations, eq(locations.id, stockMovements.locationId))
    .leftJoin(serialItems, eq(serialItems.id, stockMovements.serialItemId))
    .leftJoin(users, eq(users.id, stockMovements.actorUserId))
    .where(and(...where))
    .orderBy(
      ...(order === 'desc'
        ? [desc(stockMovements.occurredAt), desc(stockMovements.id)]
        : [asc(stockMovements.occurredAt), asc(stockMovements.id)]),
    )
    .limit(options.limit ?? 1000);
  return rows.map((r) => ({
    id: r.m.id,
    variantId: r.m.variantId,
    sku: r.sku,
    location: locRef(r.loc),
    condition: r.m.condition,
    serialItem: r.m.serialItemId && r.serialTag ? { id: r.m.serialItemId, serialTag: r.serialTag } : null,
    type: r.m.type,
    onHandDelta: r.m.onHandDelta,
    reservedDelta: r.m.reservedDelta,
    committedDelta: r.m.committedDelta,
    reasonCode: r.m.reasonCode,
    note: r.m.note,
    reference: r.m.reference,
    operationId: r.m.operationId,
    reservationId: r.m.reservationId,
    actor: r.m.actorUserId ? { id: r.m.actorUserId, name: r.actorName ?? 'Former user' } : null,
    occurredAt: iso(r.m.occurredAt),
  }));
}

export async function operationMovements(tx: Tx, tenantId: string, operationId: string) {
  return loadMovements(
    tx,
    [eq(stockMovements.tenantId, tenantId), eq(stockMovements.operationId, operationId)],
    {
      order: 'asc',
    },
  );
}

// ---------------------------------------------------------------- reservations

export function reservationQuery(tx: Tx) {
  return tx
    .select({
      r: reservations,
      sku: variants.sku,
      productTitle: products.title,
      loc: { id: locations.id, code: locations.code, name: locations.name },
      serialTag: serialItems.serialTag,
      creatorName: users.displayName,
    })
    .from(reservations)
    .innerJoin(variants, eq(variants.id, reservations.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .innerJoin(locations, eq(locations.id, reservations.locationId))
    .leftJoin(serialItems, eq(serialItems.id, reservations.serialItemId))
    .leftJoin(users, eq(users.id, reservations.createdBy));
}

type ReservationJoin = Awaited<ReturnType<ReturnType<typeof reservationQuery>['where']>>[number];

export function toReservation(row: ReservationJoin): Reservation {
  const r = row.r;
  return {
    id: r.id,
    variantId: r.variantId,
    sku: row.sku,
    productTitle: row.productTitle,
    location: locRef(row.loc),
    serialItem: r.serialItemId && row.serialTag ? { id: r.serialItemId, serialTag: row.serialTag } : null,
    channelId: r.channelId,
    quantity: qty(r.quantity),
    status: r.status,
    referenceType: r.referenceType,
    referenceId: r.referenceId,
    expiresAt: r.expiresAt ? iso(r.expiresAt) : null,
    note: r.note,
    createdBy: r.createdBy ? { id: r.createdBy, name: row.creatorName ?? 'Former user' } : null,
    closedReason: r.closedReason,
    closedAt: r.closedAt ? iso(r.closedAt) : null,
    version: r.version,
    createdAt: iso(r.createdAt),
  };
}

export async function loadReservation(tx: Tx, tenantId: string, id: string): Promise<Reservation> {
  const [row] = await reservationQuery(tx).where(
    and(eq(reservations.tenantId, tenantId), eq(reservations.id, id)),
  );
  if (!row) throw Errors.notFound('Reservation');
  return toReservation(row);
}

// ---------------------------------------------------------------- transfers

const fromLoc = alias(locations, 'from_loc');
const toLoc = alias(locations, 'to_loc');
const creator = alias(users, 'creator');
const receiver = alias(users, 'receiver');

export function transferQuery(tx: Tx) {
  return tx
    .select({
      t: transfers,
      from: { id: fromLoc.id, code: fromLoc.code, name: fromLoc.name },
      to: { id: toLoc.id, code: toLoc.code, name: toLoc.name },
      creatorName: creator.displayName,
      receiverName: receiver.displayName,
      lineCount: sql<number>`(select count(*)::int from transfer_lines tl where tl.transfer_id = "transfers"."id")`,
    })
    .from(transfers)
    .innerJoin(fromLoc, eq(fromLoc.id, transfers.fromLocationId))
    .innerJoin(toLoc, eq(toLoc.id, transfers.toLocationId))
    .leftJoin(creator, eq(creator.id, transfers.createdBy))
    .leftJoin(receiver, eq(receiver.id, transfers.receivedBy));
}

type TransferJoin = Awaited<ReturnType<ReturnType<typeof transferQuery>['where']>>[number];

export function toTransferSummary(row: TransferJoin): Omit<Transfer, 'lines'> & { lineCount: number } {
  const t = row.t;
  return {
    id: t.id,
    number: t.number,
    from: locRef(row.from),
    to: locRef(row.to),
    status: t.status,
    note: t.note,
    createdBy: t.createdBy ? { id: t.createdBy, name: row.creatorName ?? 'Former user' } : null,
    receivedBy: t.receivedBy ? { id: t.receivedBy, name: row.receiverName ?? 'Former user' } : null,
    receivedAt: t.receivedAt ? iso(t.receivedAt) : null,
    version: t.version,
    createdAt: iso(t.createdAt),
    lineCount: row.lineCount,
  };
}

export async function loadTransfer(tx: Tx, tenantId: string, id: string): Promise<Transfer> {
  const [row] = await transferQuery(tx).where(and(eq(transfers.tenantId, tenantId), eq(transfers.id, id)));
  if (!row) throw Errors.notFound('Transfer');
  const lines = await tx
    .select({
      l: transferLines,
      sku: variants.sku,
      productTitle: products.title,
      serialTag: serialItems.serialTag,
    })
    .from(transferLines)
    .innerJoin(variants, eq(variants.id, transferLines.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .leftJoin(serialItems, eq(serialItems.id, transferLines.serialItemId))
    .where(eq(transferLines.transferId, id))
    .orderBy(asc(variants.sku), asc(serialItems.serialTag));
  const { lineCount: _lineCount, ...summary } = toTransferSummary(row);
  return {
    ...summary,
    lines: lines.map((l) => ({
      variantId: l.l.variantId,
      sku: l.sku,
      productTitle: l.productTitle,
      quantity: qty(l.l.quantity),
      serialItem: l.l.serialItemId && l.serialTag ? { id: l.l.serialItemId, serialTag: l.serialTag } : null,
    })),
  };
}

// ---------------------------------------------------------------- issues

export function issueQuery(tx: Tx) {
  return tx
    .select({
      i: reconciliationIssues,
      sku: variants.sku,
      loc: { id: locations.id, code: locations.code, name: locations.name },
      resolverName: users.displayName,
    })
    .from(reconciliationIssues)
    .leftJoin(variants, eq(variants.id, reconciliationIssues.variantId))
    .leftJoin(locations, eq(locations.id, reconciliationIssues.locationId))
    .leftJoin(users, eq(users.id, reconciliationIssues.resolvedBy));
}

type IssueJoin = Awaited<ReturnType<ReturnType<typeof issueQuery>['where']>>[number];

export function toIssue(row: IssueJoin): ReconciliationIssue {
  const i = row.i;
  return {
    id: i.id,
    domain: i.domain,
    kind: i.kind,
    severity: i.severity,
    variant: i.variantId && row.sku ? { id: i.variantId, sku: row.sku } : null,
    location: row.loc?.id ? locRef(row.loc) : null,
    details: i.details as Record<string, unknown>,
    status: i.status,
    resolvedBy: i.resolvedBy ? { id: i.resolvedBy, name: row.resolverName ?? 'Former user' } : null,
    resolutionNote: i.resolutionNote,
    resolvedAt: i.resolvedAt ? iso(i.resolvedAt) : null,
    createdAt: iso(i.createdAt),
  };
}
