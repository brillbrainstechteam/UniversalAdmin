import { Injectable } from '@nestjs/common';
import {
  qty,
  qtyAdd,
  qtyCmp,
  qtyMax0,
  qtySub,
  type ChannelStockLocations,
  type InventorySummary,
  type IssueListQuery,
  type MovementQuery,
  type Page,
  type ReconciliationIssue,
  type Reservation,
  type ReservationListQuery,
  type StockCount,
  type StockCountListQuery,
  type StockLevel,
  type StockLevelQuery,
  type StockMovement,
  type StockSettings,
  type Transfer,
  type TransferListQuery,
  type VariantStock,
} from '@uc/contracts';
import {
  channels,
  channelStockLocations,
  loadStockProfile,
  locations,
  products,
  reconciliationIssues,
  reservations,
  serialItems,
  stockBalances,
  stockCountLines,
  stockCounts,
  stockMovements,
  stockSettings,
  transfers,
  users,
  variants,
  variantStockSettings,
  type Tx,
} from '@uc/db';
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { decodeCursor, paginate } from '../../common/cursor';
import { Errors } from '../../common/errors';
import { iso, likePattern } from '../../common/mappers';
import type { TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';
import {
  NO_LOCATION,
  assertScope,
  inScope,
  issueQuery,
  loadMovements,
  loadTransfer,
  locRef,
  requireInventory,
  reservationQuery,
  scopeFilter,
  toIssue,
  toReservation,
  toTransferSummary,
  transferQuery,
} from './inventory.common';

@Injectable()
export class InventoryQueryService {
  constructor(private readonly db: DbService) {}

  /**
   * Location ids whose stock is counted: explicit location, else the channel's stock locations (or all), always
   * intersected with the member's scope. `null` = no restriction.
   */
  private async locationSet(
    tx: Tx,
    ctx: TenantState,
    filter: { locationId?: string; channelId?: string },
  ): Promise<string[] | null> {
    let ids: string[] | null = null;
    if (filter.locationId) {
      assertScope(ctx, filter.locationId);
      ids = [filter.locationId];
    } else if (filter.channelId) {
      const [ch] = await tx
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.tenantId, ctx.tenantId), eq(channels.id, filter.channelId)));
      if (!ch) throw Errors.validation([{ path: 'channelId', message: 'Unknown channel' }]);
      const configured = await tx
        .select({ id: channelStockLocations.locationId })
        .from(channelStockLocations)
        .where(eq(channelStockLocations.channelId, filter.channelId));
      if (configured.length) ids = configured.map((c) => c.id);
    }
    if (ctx.locationScope !== null) {
      const scope = new Set(ctx.locationScope);
      ids = (ids ?? [...scope]).filter((id) => scope.has(id));
    }
    return ids;
  }

  /** Per-variant aggregation of balances in a location set; ATP only counts active locations. */
  private levelsQuery(tx: Tx, ctx: TenantState, locIds: string[] | null) {
    const sellable = sql`${stockBalances.condition} = 'sellable'`;
    const availActive = sql`coalesce(sum(${stockBalances.onHand} - ${stockBalances.reserved} - ${stockBalances.committed}) filter (where ${sellable} and ${locations.status} = 'active'), 0)`;
    const buffer = sql`coalesce(${variantStockSettings.buffer}, ${stockSettings.defaultBuffer}, 0)`;
    const threshold = sql`coalesce(${variantStockSettings.lowStockThreshold}, ${stockSettings.lowStockThreshold}, 1)`;
    const atp = sql`greatest(0, ${availActive} - ${buffer})`;
    const balanceJoin = and(
      eq(stockBalances.tenantId, variants.tenantId),
      eq(stockBalances.variantId, variants.id),
      locIds === null ? undefined : inArray(stockBalances.locationId, locIds.length ? locIds : [NO_LOCATION]),
    );
    const query = tx
      .select({
        variantId: variants.id,
        sku: variants.sku,
        variantTitle: variants.title,
        productId: products.id,
        productTitle: products.title,
        tracking: sql<'quantity' | 'serial'>`coalesce(${variantStockSettings.tracking}, 'quantity')`.as(
          'tracking',
        ),
        unit: sql<'pcs' | 'g'>`coalesce(${variantStockSettings.unit}, 'pcs')`.as('unit'),
        onHand: sql<string>`coalesce(sum(${stockBalances.onHand}) filter (where ${sellable}), 0)`.as(
          'on_hand',
        ),
        reserved: sql<string>`coalesce(sum(${stockBalances.reserved}) filter (where ${sellable}), 0)`.as(
          'reserved',
        ),
        committed: sql<string>`coalesce(sum(${stockBalances.committed}) filter (where ${sellable}), 0)`.as(
          'committed',
        ),
        available:
          sql<string>`coalesce(sum(${stockBalances.onHand} - ${stockBalances.reserved} - ${stockBalances.committed}) filter (where ${sellable}), 0)`.as(
            'available',
          ),
        unsellable:
          sql<string>`coalesce(sum(${stockBalances.onHand}) filter (where ${stockBalances.condition} in ('damaged', 'quarantine')), 0)`.as(
            'unsellable',
          ),
        inTransit:
          sql<string>`coalesce(sum(${stockBalances.onHand}) filter (where ${stockBalances.condition} = 'in_transit'), 0)`.as(
            'in_transit',
          ),
        buffer: sql<string>`${buffer}`.as('buffer'),
        threshold: sql<string>`${threshold}`.as('threshold'),
        atp: sql<string>`${atp}`.as('atp'),
        balanceRows: sql<number>`count(${stockBalances.id})::int`.as('balance_rows'),
        sortKey: sql<string>`lower(${variants.sku})`.as('sort_key'),
      })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .leftJoin(
        variantStockSettings,
        and(
          eq(variantStockSettings.tenantId, variants.tenantId),
          eq(variantStockSettings.variantId, variants.id),
        ),
      )
      .leftJoin(stockSettings, eq(stockSettings.tenantId, variants.tenantId))
      .leftJoin(stockBalances, balanceJoin)
      .leftJoin(locations, eq(locations.id, stockBalances.locationId));
    return { query, atp, threshold };
  }

  async levels(ctx: TenantState, q: StockLevelQuery): Promise<Page<StockLevel>> {
    requireInventory(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const locIds = await this.locationSet(tx, ctx, q);
      const { query, atp, threshold } = this.levelsQuery(tx, ctx, locIds);
      const where: (SQL | undefined)[] = [
        eq(variants.tenantId, ctx.tenantId),
        sql`${products.status} <> 'archived'`,
      ];
      if (q.q) {
        const p = likePattern(q.q);
        where.push(or(ilike(variants.sku, p), ilike(products.title, p), ilike(variants.title, p)));
      }
      if (cursor) {
        const key = String(cursor.sortValue ?? '');
        where.push(
          or(
            gt(sql`lower(${variants.sku})`, key),
            and(eq(sql`lower(${variants.sku})`, key), gt(variants.id, cursor.id)),
          ),
        );
      }
      const having =
        q.stock === 'out'
          ? sql`${atp} = 0`
          : q.stock === 'low'
            ? sql`${atp} > 0 and ${atp} <= ${threshold}`
            : q.stock === 'in'
              ? sql`${atp} > 0`
              : undefined;
      const rows = await query
        .where(and(...where))
        .groupBy(
          variants.id,
          products.id,
          variantStockSettings.tenantId,
          variantStockSettings.variantId,
          stockSettings.tenantId,
        )
        .having(having)
        .orderBy(sql`lower(${variants.sku})`, asc(variants.id))
        .limit(q.limit + 1);
      const page = paginate(
        rows.map((r) => ({ ...r, id: r.variantId })),
        q.limit,
        (r) => r.sortKey,
      );
      return {
        items: page.items.map((r) => ({
          variantId: r.variantId,
          productId: r.productId,
          productTitle: r.productTitle,
          variantTitle: r.variantTitle,
          sku: r.sku,
          tracking: r.tracking,
          unit: r.unit,
          onHand: qty(r.onHand),
          reserved: qty(r.reserved),
          committed: qty(r.committed),
          available: qty(r.available),
          unsellable: qty(r.unsellable),
          inTransit: qty(r.inTransit),
          buffer: qty(r.buffer),
          atp: qty(r.atp),
          lowStock: qtyCmp(r.atp, '0') > 0 && qtyCmp(r.atp, r.threshold) <= 0,
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  async summary(ctx: TenantState): Promise<InventorySummary> {
    requireInventory(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const locIds = await this.locationSet(tx, ctx, {});
      const { query } = this.levelsQuery(tx, ctx, locIds);
      const lv = query
        .where(and(eq(variants.tenantId, ctx.tenantId), sql`${products.status} <> 'archived'`))
        .groupBy(
          variants.id,
          products.id,
          variantStockSettings.tenantId,
          variantStockSettings.variantId,
          stockSettings.tenantId,
        )
        .as('lv');
      const [counts] = await tx
        .select({
          tracked: sql<number>`count(*) filter (where ${lv.balanceRows} > 0)::int`,
          out: sql<number>`count(*) filter (where ${lv.balanceRows} > 0 and ${lv.atp} = 0)::int`,
          low: sql<number>`count(*) filter (where ${lv.balanceRows} > 0 and ${lv.atp} > 0 and ${lv.atp} <= ${lv.threshold})::int`,
        })
        .from(lv);
      const resScope = scopeFilter(ctx, reservations.locationId);
      const [holds] = await tx
        .select({
          held: sql<number>`count(*) filter (where ${reservations.status} = 'held' and ${reservations.expiresAt} > now())::int`,
          committed: sql<number>`count(*) filter (where ${reservations.status} = 'committed')::int`,
        })
        .from(reservations)
        .where(
          and(
            eq(reservations.tenantId, ctx.tenantId),
            inArray(reservations.status, ['held', 'committed']),
            resScope,
          ),
        );
      const [moving] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(transfers)
        .where(
          and(
            eq(transfers.tenantId, ctx.tenantId),
            eq(transfers.status, 'in_transit'),
            ctx.locationScope === null
              ? undefined
              : or(scopeFilter(ctx, transfers.fromLocationId), scopeFilter(ctx, transfers.toLocationId)),
          ),
        );
      const [issues] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(reconciliationIssues)
        .where(
          and(
            eq(reconciliationIssues.tenantId, ctx.tenantId),
            eq(reconciliationIssues.status, 'open'),
            ctx.locationScope === null
              ? undefined
              : or(
                  isNull(reconciliationIssues.locationId),
                  scopeFilter(ctx, reconciliationIssues.locationId),
                ),
          ),
        );
      return {
        trackedVariants: counts?.tracked ?? 0,
        lowStock: counts?.low ?? 0,
        outOfStock: counts?.out ?? 0,
        activeHolds: holds?.held ?? 0,
        committedReservations: holds?.committed ?? 0,
        transfersInTransit: moving?.n ?? 0,
        openIssues: issues?.n ?? 0,
      };
    });
  }

  async variant(ctx: TenantState, variantId: string): Promise<VariantStock> {
    requireInventory(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [v] = await tx
        .select({ v: variants, p: products })
        .from(variants)
        .innerJoin(products, eq(products.id, variants.productId))
        .where(and(eq(variants.tenantId, ctx.tenantId), eq(variants.id, variantId)));
      if (!v) throw Errors.notFound('Variant');
      const profile = await loadStockProfile(tx, ctx.tenantId, variantId);
      const [own] = await tx
        .select()
        .from(variantStockSettings)
        .where(
          and(eq(variantStockSettings.tenantId, ctx.tenantId), eq(variantStockSettings.variantId, variantId)),
        );
      const balances = await tx
        .select({ b: stockBalances, loc: locations })
        .from(stockBalances)
        .innerJoin(locations, eq(locations.id, stockBalances.locationId))
        .where(
          and(
            eq(stockBalances.tenantId, ctx.tenantId),
            eq(stockBalances.variantId, variantId),
            scopeFilter(ctx, stockBalances.locationId),
          ),
        )
        .orderBy(asc(locations.name), asc(stockBalances.condition));
      const availableAt = new Map<string, { loc: (typeof balances)[number]['loc']; available: string }>();
      for (const { b, loc } of balances) {
        if (b.condition !== 'sellable' || loc.status !== 'active') continue;
        availableAt.set(loc.id, { loc, available: qtySub(b.onHand, qtyAdd(b.reserved, b.committed)) });
      }
      const atpOf = (ids: Iterable<string>) => {
        let sum = '0';
        for (const id of ids) sum = qtyAdd(sum, qtyMax0(availableAt.get(id)?.available ?? '0'));
        return profile.tracking === 'serial' ? qty(sum) : qtyMax0(qtySub(sum, profile.buffer));
      };
      let byChannel: VariantStock['atp']['byChannel'] = [];
      if (ctx.locationScope === null) {
        const chans = await tx
          .select()
          .from(channels)
          .where(and(eq(channels.tenantId, ctx.tenantId), eq(channels.status, 'active')))
          .orderBy(asc(channels.name));
        const links = await tx
          .select()
          .from(channelStockLocations)
          .where(eq(channelStockLocations.tenantId, ctx.tenantId));
        byChannel = chans.map((c) => {
          const own = links.filter((l) => l.channelId === c.id).map((l) => l.locationId);
          return { channelId: c.id, name: c.name, atp: atpOf(own.length ? own : availableAt.keys()) };
        });
      }
      const pieces =
        profile.tracking === 'serial' || v.p.productType === 'jewellery'
          ? await tx
              .select({
                i: serialItems,
                loc: { id: locations.id, code: locations.code, name: locations.name },
              })
              .from(serialItems)
              .leftJoin(locations, eq(locations.id, serialItems.locationId))
              .where(and(eq(serialItems.tenantId, ctx.tenantId), eq(serialItems.variantId, variantId)))
              .orderBy(asc(serialItems.serialTag))
              .limit(500)
          : [];
      return {
        variantId,
        productId: v.p.id,
        productTitle: v.p.title,
        variantTitle: v.v.title,
        sku: v.v.sku,
        productType: v.p.productType,
        settings: {
          tracking: profile.tracking,
          unit: profile.unit,
          buffer: own?.buffer ?? null,
          lowStockThreshold: own?.lowStockThreshold ?? null,
          effectiveBuffer: qty(profile.buffer),
          effectiveLowStockThreshold: qty(profile.lowStockThreshold),
          version: profile.version,
        },
        balances: balances.map(({ b, loc }) => ({
          location: locRef(loc),
          condition: b.condition,
          onHand: qty(b.onHand),
          reserved: qty(b.reserved),
          committed: qty(b.committed),
          available:
            b.condition === 'sellable' ? qtySub(b.onHand, qtyAdd(b.reserved, b.committed)) : qty('0'),
          updatedAt: iso(b.updatedAt),
        })),
        atp: {
          total: atpOf(availableAt.keys()),
          byLocation: [...availableAt.values()].map((a) => ({
            location: locRef(a.loc),
            available: qtyMax0(a.available),
          })),
          byChannel,
        },
        pieces: pieces
          .filter((p) => !p.i.locationId || inScope(ctx, p.i.locationId))
          .map((p) => ({
            id: p.i.id,
            serialTag: p.i.serialTag,
            huid: p.i.huid,
            status: p.i.status,
            stockState: p.i.stockState,
            location: p.loc?.id ? locRef(p.loc) : null,
            grossG: p.i.grossG,
          })),
      };
    });
  }

  async movements(ctx: TenantState, q: MovementQuery): Promise<Page<StockMovement>> {
    requireInventory(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const where: (SQL | undefined)[] = [
        eq(stockMovements.tenantId, ctx.tenantId),
        scopeFilter(ctx, stockMovements.locationId),
        q.variantId ? eq(stockMovements.variantId, q.variantId) : undefined,
        q.locationId ? eq(stockMovements.locationId, q.locationId) : undefined,
        q.type ? eq(stockMovements.type, q.type) : undefined,
        q.operationId ? eq(stockMovements.operationId, q.operationId) : undefined,
        q.reference ? eq(stockMovements.reference, q.reference) : undefined,
      ];
      if (cursor) {
        const at = new Date(String(cursor.sortValue));
        where.push(
          or(
            lt(stockMovements.occurredAt, at),
            and(eq(stockMovements.occurredAt, at), lt(stockMovements.id, cursor.id)),
          ),
        );
      }
      const rows = await loadMovements(tx, where, { limit: q.limit + 1 });
      return paginate(rows, q.limit, (r) => r.occurredAt);
    });
  }

  async settings(ctx: TenantState): Promise<StockSettings> {
    requireInventory(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [s] = await tx.select().from(stockSettings).where(eq(stockSettings.tenantId, ctx.tenantId));
      if (!s) throw Errors.notFound('Stock settings');
      return toSettings(s);
    });
  }

  async channelLocations(ctx: TenantState): Promise<{ items: ChannelStockLocations[] }> {
    requireInventory(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const chans = await tx
        .select()
        .from(channels)
        .where(eq(channels.tenantId, ctx.tenantId))
        .orderBy(asc(channels.name));
      const links = await tx
        .select()
        .from(channelStockLocations)
        .where(eq(channelStockLocations.tenantId, ctx.tenantId));
      return {
        items: chans.map((c) => ({
          channelId: c.id,
          code: c.code,
          name: c.name,
          locationIds: links.filter((l) => l.channelId === c.id).map((l) => l.locationId),
        })),
      };
    });
  }

  async reservations(ctx: TenantState, q: ReservationListQuery): Promise<Page<Reservation>> {
    requireInventory(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const where: (SQL | undefined)[] = [
        eq(reservations.tenantId, ctx.tenantId),
        scopeFilter(ctx, reservations.locationId),
        q.status ? eq(reservations.status, q.status) : undefined,
        q.variantId ? eq(reservations.variantId, q.variantId) : undefined,
        q.locationId ? eq(reservations.locationId, q.locationId) : undefined,
      ];
      if (cursor) {
        const at = new Date(String(cursor.sortValue));
        where.push(
          or(
            lt(reservations.createdAt, at),
            and(eq(reservations.createdAt, at), lt(reservations.id, cursor.id)),
          ),
        );
      }
      const rows = await reservationQuery(tx)
        .where(and(...where))
        .orderBy(desc(reservations.createdAt), desc(reservations.id))
        .limit(q.limit + 1);
      return paginate(rows.map(toReservation), q.limit, (r) => r.createdAt);
    });
  }

  async transfers(ctx: TenantState, q: TransferListQuery) {
    requireInventory(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const where: (SQL | undefined)[] = [
        eq(transfers.tenantId, ctx.tenantId),
        q.status ? eq(transfers.status, q.status) : undefined,
        q.locationId
          ? or(eq(transfers.fromLocationId, q.locationId), eq(transfers.toLocationId, q.locationId))
          : undefined,
        ctx.locationScope === null
          ? undefined
          : or(scopeFilter(ctx, transfers.fromLocationId), scopeFilter(ctx, transfers.toLocationId)),
      ];
      if (cursor) {
        const at = new Date(String(cursor.sortValue));
        where.push(
          or(lt(transfers.createdAt, at), and(eq(transfers.createdAt, at), lt(transfers.id, cursor.id))),
        );
      }
      const rows = await transferQuery(tx)
        .where(and(...where))
        .orderBy(desc(transfers.createdAt), desc(transfers.id))
        .limit(q.limit + 1);
      return paginate(rows.map(toTransferSummary), q.limit, (r) => r.createdAt);
    });
  }

  async transfer(ctx: TenantState, id: string): Promise<Transfer> {
    requireInventory(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const t = await loadTransfer(tx, ctx.tenantId, id);
      if (!inScope(ctx, t.from.id) && !inScope(ctx, t.to.id)) throw Errors.notFound('Transfer');
      return t;
    });
  }

  async counts(ctx: TenantState, q: StockCountListQuery) {
    requireInventory(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const where: (SQL | undefined)[] = [
        eq(stockCounts.tenantId, ctx.tenantId),
        scopeFilter(ctx, stockCounts.locationId),
        q.locationId ? eq(stockCounts.locationId, q.locationId) : undefined,
      ];
      if (cursor) {
        const at = new Date(String(cursor.sortValue));
        where.push(
          or(
            lt(stockCounts.createdAt, at),
            and(eq(stockCounts.createdAt, at), lt(stockCounts.id, cursor.id)),
          ),
        );
      }
      const rows = await countQuery(tx)
        .where(and(...where))
        .orderBy(desc(stockCounts.createdAt), desc(stockCounts.id))
        .limit(q.limit + 1);
      return paginate(
        rows.map((r) => {
          const { lines: _lines, ...rest } = toCount(r, []);
          return { ...rest, id: r.c.id, lineCount: r.lineCount };
        }),
        q.limit,
        (r) => r.createdAt ?? '',
      );
    });
  }

  async count(ctx: TenantState, id: string): Promise<StockCount> {
    requireInventory(ctx);
    return this.db.tenant(ctx.tenantId, (tx) => loadCount(tx, ctx, id));
  }

  async issues(ctx: TenantState, q: IssueListQuery): Promise<Page<ReconciliationIssue>> {
    requireInventory(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const where: (SQL | undefined)[] = [
        eq(reconciliationIssues.tenantId, ctx.tenantId),
        eq(reconciliationIssues.status, q.status),
        q.kind ? eq(reconciliationIssues.kind, q.kind) : undefined,
        ctx.locationScope === null
          ? undefined
          : or(isNull(reconciliationIssues.locationId), scopeFilter(ctx, reconciliationIssues.locationId)),
      ];
      if (cursor) {
        const at = new Date(String(cursor.sortValue));
        where.push(
          or(
            lt(reconciliationIssues.createdAt, at),
            and(eq(reconciliationIssues.createdAt, at), lt(reconciliationIssues.id, cursor.id)),
          ),
        );
      }
      const rows = await issueQuery(tx)
        .where(and(...where))
        .orderBy(desc(reconciliationIssues.createdAt), desc(reconciliationIssues.id))
        .limit(q.limit + 1);
      return paginate(rows.map(toIssue), q.limit, (r) => r.createdAt);
    });
  }
}

export function toSettings(s: typeof stockSettings.$inferSelect): StockSettings {
  return {
    defaultBuffer: qty(s.defaultBuffer),
    reservationTtlMinutes: s.reservationTtlMinutes,
    lowStockThreshold: qty(s.lowStockThreshold),
    backorderPolicy: s.backorderPolicy,
    version: s.version,
    updatedAt: iso(s.updatedAt),
  };
}

function countQuery(tx: Tx) {
  return tx
    .select({
      c: stockCounts,
      loc: { id: locations.id, code: locations.code, name: locations.name },
      creatorName: users.displayName,
      issueId: sql<
        string | null
      >`(select ri.id from reconciliation_issues ri where ri.tenant_id = "stock_counts"."tenant_id" and ri.dedupe_key = 'stale:' || "stock_counts"."id"::text limit 1)`,
      lineCount: sql<number>`(select count(*)::int from stock_count_lines scl where scl.count_id = "stock_counts"."id")`,
    })
    .from(stockCounts)
    .innerJoin(locations, eq(locations.id, stockCounts.locationId))
    .leftJoin(users, eq(users.id, stockCounts.createdBy));
}

type CountJoin = Awaited<ReturnType<ReturnType<typeof countQuery>['where']>>[number];

function toCount(r: CountJoin, lines: StockCount['lines']): StockCount {
  return {
    id: r.c.id,
    location: locRef(r.loc),
    source: r.c.source,
    sourceVersion: r.c.sourceVersion,
    asOf: iso(r.c.asOf),
    status: r.c.status,
    reference: r.c.reference,
    note: r.c.note,
    operationId: r.c.status === 'applied' ? r.c.id : null,
    issueId: r.issueId,
    lines,
    createdBy: r.c.createdBy ? { id: r.c.createdBy, name: r.creatorName ?? 'Former user' } : null,
    createdAt: iso(r.c.createdAt),
  };
}

export async function loadCount(tx: Tx, ctx: TenantState, id: string): Promise<StockCount> {
  const [row] = await countQuery(tx).where(
    and(eq(stockCounts.tenantId, ctx.tenantId), eq(stockCounts.id, id)),
  );
  if (!row || !inScope(ctx, row.c.locationId)) throw Errors.notFound('Stock count');
  const lines = await tx
    .select({ l: stockCountLines, sku: variants.sku })
    .from(stockCountLines)
    .innerJoin(variants, eq(variants.id, stockCountLines.variantId))
    .where(eq(stockCountLines.countId, id))
    .orderBy(asc(variants.sku));
  return toCount(
    row,
    lines.map((l) => ({
      variantId: l.l.variantId,
      sku: l.sku,
      counted: qty(l.l.counted),
      expected: qty(l.l.expected),
      variance: qty(l.l.variance),
    })),
  );
}
