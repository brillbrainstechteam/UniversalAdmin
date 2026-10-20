import { Injectable } from '@nestjs/common';
import {
  cmpDecimal,
  type Discount,
  type DiscountListQuery,
  type Page,
  type SaveDiscountRequest,
} from '@uc/contracts';
import { channels, discounts, segments, writeAudit, type Tx } from '@uc/db';
import { and, desc, eq, ilike, inArray, lt, or, type SQL } from 'drizzle-orm';
import { decodeCursor, paginate } from '../../common/cursor';
import { Errors } from '../../common/errors';
import { iso, likePattern } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';

type Row = typeof discounts.$inferSelect;

function requireDiscounts(ctx: Pick<TenantState, 'features'>) {
  if (!ctx.features.includes('discounts')) throw Errors.featureNotEntitled('discounts');
}

/** Staff management of discounts (Phase 10). Evaluation lives in PromotionsService. */
@Injectable()
export class DiscountsService {
  constructor(private readonly db: DbService) {}

  private state(d: Row, now = new Date()): Discount['state'] {
    if (d.status === 'disabled') return 'disabled';
    if (d.startsAt > now) return 'scheduled';
    if (d.endsAt && d.endsAt <= now) return 'expired';
    if (d.usageLimit !== null && d.usedCount >= d.usageLimit) return 'used_up';
    return 'live';
  }

  private async view(tx: Tx, rows: Row[]): Promise<Discount[]> {
    const segIds = [...new Set(rows.map((r) => r.segmentId).filter((x): x is string => !!x))];
    const segs = segIds.length
      ? await tx
          .select({ id: segments.id, name: segments.name })
          .from(segments)
          .where(inArray(segments.id, segIds))
      : [];
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      code: d.code,
      mode: d.mode,
      value: d.value,
      currency: d.currency,
      minSubtotalMinor: d.minSubtotalMinor?.toString() ?? null,
      startsAt: iso(d.startsAt),
      endsAt: d.endsAt ? iso(d.endsAt) : null,
      usageLimit: d.usageLimit,
      perCustomerLimit: d.perCustomerLimit,
      segment: segs.find((s) => s.id === d.segmentId) ?? null,
      channelIds: d.channelIds,
      combinable: d.combinable,
      status: d.status,
      usedCount: d.usedCount,
      state: this.state(d),
      version: d.version,
      createdAt: iso(d.createdAt),
    }));
  }

  async list(ctx: TenantState, q: DiscountListQuery): Promise<Page<Discount>> {
    requireDiscounts(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const where: (SQL | undefined)[] = [eq(discounts.tenantId, ctx.tenantId)];
      if (q.q)
        where.push(
          or(ilike(discounts.name, likePattern(q.q)), ilike(discounts.code, likePattern(q.q.toUpperCase()))),
        );
      if (cursor) {
        const t = new Date(String(cursor.sortValue));
        where.push(
          or(lt(discounts.createdAt, t), and(eq(discounts.createdAt, t), lt(discounts.id, cursor.id))),
        );
      }
      const rows = await tx
        .select()
        .from(discounts)
        .where(and(...where))
        .orderBy(desc(discounts.createdAt), desc(discounts.id))
        .limit(q.limit + 1);
      const page = paginate(rows, q.limit, (r) => r.createdAt.toISOString());
      return { items: await this.view(tx, page.items), nextCursor: page.nextCursor };
    });
  }

  private async check(tx: Tx, ctx: TenantState, input: SaveDiscountRequest) {
    if (input.segmentId) {
      const [s] = await tx
        .select({ id: segments.id })
        .from(segments)
        .where(and(eq(segments.id, input.segmentId), eq(segments.tenantId, ctx.tenantId)));
      if (!s) throw Errors.validation([{ path: 'segmentId', message: 'Unknown segment' }]);
    }
    if (input.channelIds.length) {
      const found = await tx
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.tenantId, ctx.tenantId), inArray(channels.id, input.channelIds)));
      if (found.length !== new Set(input.channelIds).size)
        throw Errors.validation([{ path: 'channelIds', message: 'Unknown channel' }]);
    }
  }

  private values(input: SaveDiscountRequest) {
    return {
      name: input.name,
      code: input.code,
      mode: input.mode,
      value: input.value,
      currency: input.mode === 'fixed' ? input.currency : null,
      minSubtotalMinor: input.minSubtotalMinor === null ? null : BigInt(input.minSubtotalMinor),
      startsAt: new Date(input.startsAt),
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
      usageLimit: input.usageLimit,
      perCustomerLimit: input.perCustomerLimit,
      segmentId: input.segmentId,
      channelIds: [...new Set(input.channelIds)],
      combinable: input.combinable,
      status: input.status,
    };
  }

  async create(
    auth: AuthState,
    ctx: TenantState,
    input: SaveDiscountRequest,
    meta: RequestMeta,
  ): Promise<Discount> {
    requireDiscounts(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await this.check(tx, ctx, input);
      const [row] = await tx
        .insert(discounts)
        .values({ tenantId: ctx.tenantId, ...this.values(input), createdBy: auth.userId })
        .onConflictDoNothing()
        .returning();
      if (!row) throw Errors.duplicate('code', `The code ${input.code} is already in use`);
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: 'discounts.created',
        entityType: 'discount',
        entityId: row.id,
        newValues: { name: row.name, code: row.code, mode: row.mode, value: row.value },
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return (await this.view(tx, [row]))[0]!;
    });
  }

  async update(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: SaveDiscountRequest,
    meta: RequestMeta,
  ): Promise<Discount> {
    requireDiscounts(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [d] = await tx.select().from(discounts).where(eq(discounts.id, id)).for('update');
      if (!d || d.tenantId !== ctx.tenantId) throw Errors.notFound('Discount');
      if (input.version === undefined || d.version !== input.version) throw Errors.versionConflict(d.version);
      await this.check(tx, ctx, input);
      // Once used, the terms that explain past orders stay fixed: only schedule, limits and status can change.
      const termsChanged =
        input.mode !== d.mode ||
        cmpDecimal(input.value, d.value) !== 0 ||
        (input.code ?? null) !== d.code ||
        (input.currency ?? null) !== d.currency;
      if (d.usedCount > 0 && termsChanged)
        throw Errors.conflict(
          'INVALID_STATE_TRANSITION',
          'This discount has been used; create a new one to change its code or amount',
        );
      if (input.usageLimit !== null && input.usageLimit < d.usedCount)
        throw Errors.validation([{ path: 'usageLimit', message: `Already used ${d.usedCount} times` }]);
      const [after] = await tx
        .update(discounts)
        .set({ ...this.values(input), version: d.version + 1, updatedAt: new Date() })
        .where(eq(discounts.id, d.id))
        .returning();
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: 'discounts.updated',
        entityType: 'discount',
        entityId: d.id,
        oldValues: { status: d.status, endsAt: d.endsAt?.toISOString() ?? null, usageLimit: d.usageLimit },
        newValues: {
          status: after!.status,
          endsAt: after!.endsAt?.toISOString() ?? null,
          usageLimit: after!.usageLimit,
        },
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return (await this.view(tx, [after!]))[0]!;
    });
  }
}
