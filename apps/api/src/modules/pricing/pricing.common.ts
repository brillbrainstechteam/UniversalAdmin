import { RATE_PROVIDERS, type MetalRate, type PricingSettings } from '@uc/contracts';
import {
  metalRates,
  pricingSettings,
  purityDefinitions,
  rateSources,
  tenants,
  users,
  writeAudit,
  type Tx,
} from '@uc/db';
import { and, desc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { Errors } from '../../common/errors';
import { iso } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';

export type RateRow = typeof metalRates.$inferSelect;
export type SourceRow = typeof rateSources.$inferSelect;
export type SettingsRow = typeof pricingSettings.$inferSelect;
type PurityRow = typeof purityDefinitions.$inferSelect;

export function requirePricing(ctx: TenantState) {
  if (!ctx.features.includes('pricing')) throw Errors.featureNotEntitled('pricing');
}
export function requireMetalRates(ctx: TenantState) {
  if (!ctx.features.includes('metal_rates')) throw Errors.featureNotEntitled('metal_rates');
}

export function audit(
  tx: Tx,
  auth: AuthState | null,
  ctx: { tenantId: string },
  meta: RequestMeta,
  action: string,
  entityType: string,
  entityId: string,
  values: {
    oldValues?: Record<string, unknown> | null;
    newValues?: Record<string, unknown> | null;
    reason?: string | null;
  },
) {
  return writeAudit(tx, {
    tenantId: ctx.tenantId,
    actorType: auth ? 'user' : 'system',
    actorUserId: auth?.userId ?? null,
    action,
    entityType,
    entityId,
    oldValues: values.oldValues ?? null,
    newValues: values.newValues ?? null,
    reason: values.reason ?? null,
    correlationId: meta.correlationId,
    ip: meta.ip,
  });
}

export async function loadPricingSettings(tx: Tx, tenantId: string): Promise<SettingsRow> {
  await tx.insert(pricingSettings).values({ tenantId }).onConflictDoNothing();
  const [row] = await tx.select().from(pricingSettings).where(eq(pricingSettings.tenantId, tenantId));
  return row!;
}

export function toSettings(row: SettingsRow): PricingSettings {
  return {
    quoteTtlMinutes: row.quoteTtlMinutes,
    rateMaxAgeMinutes: row.rateMaxAgeMinutes,
    stalePolicy: row.stalePolicy,
    ruleReviewRequired: row.ruleReviewRequired,
    version: row.version,
    updatedAt: iso(row.updatedAt),
  };
}

export async function tenantCurrency(tx: Tx, tenantId: string): Promise<string> {
  const [t] = await tx.select({ c: tenants.defaultCurrency }).from(tenants).where(eq(tenants.id, tenantId));
  return t!.c;
}

export async function manualSource(tx: Tx, tenantId: string): Promise<SourceRow> {
  await tx
    .insert(rateSources)
    .values({ tenantId, name: 'Manual entry', kind: 'manual' })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(rateSources)
    .where(and(eq(rateSources.tenantId, tenantId), eq(rateSources.kind, 'manual')));
  return row!;
}

export const isSimulated = (s: Pick<SourceRow, 'providerKey'>) =>
  RATE_PROVIDERS.find((p) => p.key === s.providerKey)?.simulated ?? false;

export function isStale(
  rate: Pick<RateRow, 'sourceAsOf'>,
  settings: Pick<SettingsRow, 'rateMaxAgeMinutes'>,
  now = new Date(),
) {
  return now.getTime() - rate.sourceAsOf.getTime() > settings.rateMaxAgeMinutes * 60_000;
}

/**
 * The rate quotes use now: latest approved rate with effective_from ≤ now for purity + currency (ties broken by
 * approval time). Never returns a proposed or rejected rate.
 */
export async function currentRates(
  tx: Tx,
  tenantId: string,
  currency: string,
  purityIds?: string[],
  now = new Date(),
): Promise<Map<string, RateRow>> {
  if (purityIds && purityIds.length === 0) return new Map();
  const rows = await tx
    .selectDistinctOn([metalRates.purityId])
    .from(metalRates)
    .where(
      and(
        eq(metalRates.tenantId, tenantId),
        eq(metalRates.currency, currency),
        eq(metalRates.status, 'approved'),
        isNotNull(metalRates.effectiveFrom),
        lte(metalRates.effectiveFrom, now),
        purityIds ? inArray(metalRates.purityId, purityIds) : undefined,
      ),
    )
    .orderBy(
      metalRates.purityId,
      desc(metalRates.effectiveFrom),
      desc(metalRates.decidedAt),
      desc(metalRates.id),
    );
  return new Map(rows.map((r) => [r.purityId, r]));
}

/** Loads rates with their source, purity and actor names, mapped to the API shape. */
export async function loadRates(
  tx: Tx,
  tenantId: string,
  rows: RateRow[],
  settings: SettingsRow,
): Promise<MetalRate[]> {
  if (!rows.length) return [];
  const sourceIds = [...new Set(rows.map((r) => r.sourceId))];
  const purityIds = [...new Set(rows.map((r) => r.purityId))];
  const userIds = [
    ...new Set(rows.flatMap((r) => [r.proposedBy, r.decidedBy]).filter((x): x is string => !!x)),
  ];
  const [sources, purities, people] = await Promise.all([
    tx.select().from(rateSources).where(inArray(rateSources.id, sourceIds)),
    tx.select().from(purityDefinitions).where(inArray(purityDefinitions.id, purityIds)),
    userIds.length
      ? tx.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, userIds))
      : Promise.resolve([] as { id: string; name: string }[]),
  ]);
  const currentIds = new Set<string>();
  for (const currency of new Set(rows.map((r) => r.currency)))
    for (const r of (await currentRates(tx, tenantId, currency, purityIds)).values()) currentIds.add(r.id);
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const purityById = new Map<string, PurityRow>(purities.map((p) => [p.id, p]));
  const nameOf = (id: string | null) =>
    id ? { id, name: people.find((p) => p.id === id)?.name ?? 'Unknown' } : null;
  return rows.map((r) => {
    const s = sourceById.get(r.sourceId)!;
    const p = purityById.get(r.purityId)!;
    return {
      id: r.id,
      source: { id: s.id, name: s.name, kind: s.kind, providerKey: s.providerKey, simulated: isSimulated(s) },
      metal: r.metal,
      purity: { id: p.id, code: p.code, label: p.label },
      currency: r.currency,
      ratePerG: r.ratePerG,
      input: { value: r.inputValue, unit: r.inputUnit },
      sourceAsOf: iso(r.sourceAsOf),
      effectiveFrom: iso(r.effectiveFrom ?? r.proposedAt),
      status: r.status,
      reason: r.reason,
      proposedBy: nameOf(r.proposedBy),
      proposedAt: iso(r.proposedAt),
      decidedBy: nameOf(r.decidedBy),
      decidedAt: r.decidedAt ? iso(r.decidedAt) : null,
      decisionNote: r.decisionNote,
      isCurrent: currentIds.has(r.id),
      stale: r.status === 'approved' && isStale(r, settings),
    };
  });
}
