import { Injectable } from '@nestjs/common';
import {
  HARD_PLAN_LIMITS,
  PLAN_LIMIT_KEYS,
  PLAN_LIMIT_LABELS,
  PlanLimits,
  type AssignPlanRequest,
  type Plan,
  type PlanLimitKey,
  type PlanUsage,
  type SavePlanRequest,
  type UsageLine,
} from '@uc/contracts';
import {
  channelDomains,
  invitations,
  locations,
  memberships,
  orders,
  plans,
  products,
  tenants,
  writeAudit,
  type Tx,
} from '@uc/db';
import { and, asc, count, eq, gt, gte, ne, sql } from 'drizzle-orm';
import { AppError, Errors } from '../../common/errors';
import type { AuthState, RequestMeta } from '../../common/request';
import { DbService } from '../../db/db.service';

type PlanRow = typeof plans.$inferSelect;

/** Limits stored as JSON are re-validated on read; anything unreadable is treated as unlimited, never as zero. */
function limitsOf(row: PlanRow): PlanLimits {
  const parsed = PlanLimits.safeParse(row.limits);
  return parsed.success
    ? parsed.data
    : { products: null, staffSeats: null, locations: null, domains: null, ordersPerMonth: null };
}

function stateOf(used: number, limit: number | null): UsageLine['state'] {
  if (limit === null) return 'unlimited';
  if (used > limit) return 'over';
  if (used === limit) return 'at';
  return used >= limit * 0.8 ? 'near' : 'ok';
}

/** Start of the current calendar month in `timezone`, as an instant. */
export function monthStartIn(timezone: string, now = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === 'year')?.value);
  const m = Number(parts.find((p) => p.type === 'month')?.value);
  // Midnight on the 1st in the zone: take UTC midnight, then correct by the zone's offset at that instant.
  const utcMidnight = Date.UTC(y, m - 1, 1);
  const local = new Date(new Date(utcMidnight).toLocaleString('en-US', { timeZone: timezone }));
  const utc = new Date(new Date(utcMidnight).toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(utcMidnight - (local.getTime() - utc.getTime()));
}

/**
 * Refuses to add `adding` records of a hard-limited kind beyond the tenant's plan. Call inside the tenant
 * transaction that inserts them: a per-tenant, per-kind advisory lock serialises concurrent creates, so two
 * requests cannot both pass the check for the last free slot.
 */
export async function assertPlanCapacity(
  tx: Tx,
  tenantId: string,
  kind: 'products' | 'staffSeats' | 'locations' | 'domains',
  adding = 1,
): Promise<void> {
  if (adding <= 0) return;
  const [row] = await tx
    .select({ limits: plans.limits, planName: plans.name })
    .from(tenants)
    .innerJoin(plans, eq(plans.key, tenants.planKey))
    .where(eq(tenants.id, tenantId));
  if (!row) return;
  const limit = PlanLimits.safeParse(row.limits).data?.[kind] ?? null;
  if (limit === null) return;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`plan:${tenantId}:${kind}`}))`);
  const used = await usedOf(tx, tenantId, kind);
  if (used + adding > limit)
    throw new AppError(
      422,
      'PLAN_LIMIT_REACHED',
      `Your ${row.planName} plan allows ${limit} ${PLAN_LIMIT_LABELS[kind].toLowerCase()}; ${used} in use. ` +
        'Remove some or ask the platform operator to change your plan.',
      { limit: kind, max: limit, used, adding },
    );
}

async function usedOf(
  tx: Tx,
  tenantId: string,
  kind: Exclude<PlanLimitKey, 'ordersPerMonth'>,
): Promise<number> {
  let n: { n: number } | undefined;
  switch (kind) {
    case 'products':
      [n] = await tx
        .select({ n: count() })
        .from(products)
        .where(and(eq(products.tenantId, tenantId), ne(products.status, 'archived')));
      break;
    case 'locations':
      [n] = await tx
        .select({ n: count() })
        .from(locations)
        .where(and(eq(locations.tenantId, tenantId), eq(locations.status, 'active')));
      break;
    case 'domains':
      [n] = await tx.select({ n: count() }).from(channelDomains).where(eq(channelDomains.tenantId, tenantId));
      break;
    case 'staffSeats': {
      const [m] = await tx
        .select({ n: count() })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.status, 'active')));
      const [i] = await tx
        .select({ n: count() })
        .from(invitations)
        .where(
          and(
            eq(invitations.tenantId, tenantId),
            eq(invitations.status, 'pending'),
            gt(invitations.expiresAt, new Date()),
          ),
        );
      return Number(m?.n ?? 0) + Number(i?.n ?? 0);
    }
  }
  return Number(n?.n ?? 0);
}

/** Plans, live usage and hard-limit enforcement (Phase 12, ADR-027). */
@Injectable()
export class PlansService {
  constructor(private readonly db: DbService) {}

  async list(): Promise<{ items: Plan[] }> {
    return this.db.system(async (tx) => {
      const rows = await tx.select().from(plans).orderBy(asc(plans.createdAt), asc(plans.key));
      const counts = await tx
        .select({ key: tenants.planKey, n: count() })
        .from(tenants)
        .groupBy(tenants.planKey);
      const byKey = new Map(counts.map((c) => [c.key, Number(c.n)]));
      return { items: rows.map((r) => this.toDto(r, byKey.get(r.key) ?? 0)) };
    });
  }

  /** Create (no version) or update (version required) a plan. */
  async save(auth: AuthState, key: string, body: SavePlanRequest, meta: RequestMeta): Promise<Plan> {
    return this.db.system(async (tx) => {
      const [existing] = await tx.select().from(plans).where(eq(plans.key, key)).for('update');
      let row: PlanRow | undefined;
      if (!existing) {
        if (body.version !== undefined) throw Errors.notFound('Plan');
        [row] = await tx
          .insert(plans)
          .values({
            key,
            name: body.name,
            description: body.description,
            limits: body.limits,
            status: body.status,
          })
          .returning();
      } else {
        if (body.version === undefined) throw Errors.duplicate('key', 'A plan with this key already exists');
        if (body.version !== existing.version) throw Errors.versionConflict(existing.version);
        if (body.status === 'retired' && key === 'pilot')
          throw Errors.unprocessable(
            'VALIDATION_FAILED',
            'The pilot plan is the default and cannot be retired',
          );
        [row] = await tx
          .update(plans)
          .set({
            name: body.name,
            description: body.description,
            limits: body.limits,
            status: body.status,
            version: existing.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(plans.key, key))
          .returning();
      }
      if (!row) throw new Error('plan write failed');
      await writeAudit(tx, {
        tenantId: null,
        actorType: 'platform',
        actorUserId: auth.userId,
        action: existing ? 'plan.updated' : 'plan.created',
        entityType: 'plan',
        entityId: key,
        oldValues: existing
          ? { key, name: existing.name, limits: existing.limits, status: existing.status }
          : null,
        newValues: { key, name: row.name, limits: row.limits, status: row.status },
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      const [n] = await tx.select({ n: count() }).from(tenants).where(eq(tenants.planKey, key));
      return this.toDto(row, Number(n?.n ?? 0));
    });
  }

  async assign(
    auth: AuthState,
    tenantId: string,
    body: AssignPlanRequest,
    meta: RequestMeta,
  ): Promise<PlanUsage> {
    await this.db.system(async (tx) => {
      const [tenant] = await tx
        .select({ planKey: tenants.planKey })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .for('update');
      if (!tenant) throw Errors.notFound('Tenant');
      await this.requireActivePlan(tx, body.planKey);
      await tx
        .update(tenants)
        .set({ planKey: body.planKey, updatedAt: new Date(), version: sql`${tenants.version} + 1` })
        .where(eq(tenants.id, tenantId));
      await writeAudit(tx, {
        tenantId,
        actorType: 'platform',
        actorUserId: auth.userId,
        action: 'tenant.plan_changed',
        entityType: 'tenant',
        entityId: tenantId,
        oldValues: { planKey: tenant.planKey },
        newValues: { planKey: body.planKey },
        reason: body.reason,
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
    });
    return this.usage(tenantId);
  }

  async requireActivePlan(tx: Tx, key: string): Promise<PlanRow> {
    const [plan] = await tx.select().from(plans).where(eq(plans.key, key));
    if (!plan || plan.status !== 'active')
      throw Errors.unprocessable('VALIDATION_FAILED', `Plan "${key}" does not exist or is retired`, {
        field: 'planKey',
      });
    return plan;
  }

  /** Usage computed live from the tables (no counters that could drift). */
  async usage(tenantId: string): Promise<PlanUsage> {
    const [tenant] = await this.db.system((tx) =>
      tx
        .select({ planKey: tenants.planKey, timezone: tenants.timezone })
        .from(tenants)
        .where(eq(tenants.id, tenantId)),
    );
    if (!tenant) throw Errors.notFound('Tenant');
    const monthStart = monthStartIn(tenant.timezone);
    return this.db.tenant(tenantId, async (tx) => {
      const [plan] = await tx.select().from(plans).where(eq(plans.key, tenant.planKey));
      if (!plan) throw new Error(`plan ${tenant.planKey} missing`);
      const limits = limitsOf(plan);
      const used: Record<PlanLimitKey, number> = {
        products: await usedOf(tx, tenantId, 'products'),
        staffSeats: await usedOf(tx, tenantId, 'staffSeats'),
        locations: await usedOf(tx, tenantId, 'locations'),
        domains: await usedOf(tx, tenantId, 'domains'),
        ordersPerMonth: await this.ordersSince(tx, tenantId, monthStart),
      };
      return {
        tenantId,
        plan: { key: plan.key, name: plan.name, description: plan.description },
        usage: PLAN_LIMIT_KEYS.map((key) => ({
          key,
          label: PLAN_LIMIT_LABELS[key],
          used: used[key],
          limit: limits[key],
          hard: HARD_PLAN_LIMITS.includes(key),
          state: stateOf(used[key], limits[key]),
        })),
        monthStart: monthStart.toISOString(),
        generatedAt: new Date().toISOString(),
        billing: 'not_connected' as const,
      };
    });
  }

  private async ordersSince(tx: Tx, tenantId: string, since: Date): Promise<number> {
    const [n] = await tx
      .select({ n: count() })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), gte(orders.createdAt, since)));
    return Number(n?.n ?? 0);
  }

  private toDto(r: PlanRow, tenantCount: number): Plan {
    return {
      key: r.key,
      name: r.name,
      description: r.description,
      limits: limitsOf(r),
      status: r.status,
      tenantCount,
      version: r.version,
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
