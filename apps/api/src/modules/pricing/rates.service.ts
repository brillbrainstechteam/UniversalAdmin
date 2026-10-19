import { Injectable } from '@nestjs/common';
import {
  PricingError,
  RATE_PROVIDERS,
  simulatorRateValue,
  ratePerGram,
  type ApproveRateRequest,
  type CreateRateSourceRequest,
  type CurrentRates,
  type MetalRate,
  type MetalRateListQuery,
  type Page,
  type ProposeRateRequest,
  type PullRatesRequest,
  type RateSource,
  type RejectRateRequest,
} from '@uc/contracts';
import { enqueueEvent, metalRates, purityDefinitions, rateSources, type Tx } from '@uc/db';
import { and, asc, count, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import { decodeCursor, paginate } from '../../common/cursor';
import { AppError, Errors } from '../../common/errors';
import { iso } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';
import {
  audit,
  currentRates,
  isSimulated,
  isStale,
  loadPricingSettings,
  loadRates,
  manualSource,
  requireMetalRates,
  tenantCurrency,
  type RateRow,
  type SourceRow,
} from './pricing.common';

const SKEW_MS = 5 * 60_000;

function toSource(s: SourceRow): RateSource {
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    providerKey: s.providerKey,
    simulated: isSimulated(s),
    status: s.status,
    credentialRef: s.credentialRef,
    licenceRef: s.licenceRef,
    lastPulledAt: s.lastPulledAt ? iso(s.lastPulledAt) : null,
    version: s.version,
  };
}

const rateInvalid = (e: PricingError, field = 'value') =>
  Errors.validation([{ path: field, message: e.message }], e.message);

/**
 * Metal rates (specs/04 "Rate governance"): append-only proposals, maker-checker approval, history, freshness.
 * Nothing here is market data unless a licensed provider is connected (none is in this build).
 */
@Injectable()
export class RatesService {
  constructor(private readonly db: DbService) {}

  // ---------------------------------------------------------------- sources

  async sources(ctx: TenantState): Promise<{ items: RateSource[]; providers: typeof RATE_PROVIDERS }> {
    requireMetalRates(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await manualSource(tx, ctx.tenantId);
      const rows = await tx
        .select()
        .from(rateSources)
        .where(eq(rateSources.tenantId, ctx.tenantId))
        .orderBy(asc(rateSources.kind), asc(rateSources.name));
      return { items: rows.map(toSource), providers: RATE_PROVIDERS };
    });
  }

  async createSource(auth: AuthState, ctx: TenantState, input: CreateRateSourceRequest, meta: RequestMeta) {
    requireMetalRates(ctx);
    const provider = RATE_PROVIDERS.find((p) => p.key === input.providerKey);
    if (!provider) throw Errors.validation([{ path: 'providerKey', message: 'Unknown rate provider' }]);
    if (provider.tier !== 'available')
      throw new AppError(409, 'CONNECTOR_UNAVAILABLE', `${provider.label} is not available yet`, {
        blockedBy: provider.blockedBy,
      });
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .insert(rateSources)
        .values({
          tenantId: ctx.tenantId,
          name: input.name,
          kind: 'provider',
          providerKey: provider.key,
          credentialRef: input.credentialRef ?? null,
          licenceRef: input.licenceRef ?? null,
          adapterState: { tick: 0 },
          createdBy: auth.userId,
        })
        .returning();
      await audit(tx, auth, ctx, meta, 'rates.source_created', 'rate_source', row!.id, {
        newValues: { name: row!.name, providerKey: row!.providerKey, credentialRef: row!.credentialRef },
      });
      return toSource(row!);
    });
  }

  /** Simulator adapter: deterministic values (base × fineness + 5 × tick) proposed for approval like any rate. */
  async pull(
    auth: AuthState,
    ctx: TenantState,
    sourceId: string,
    input: PullRatesRequest,
    meta: RequestMeta,
  ) {
    requireMetalRates(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [source] = await tx
        .select()
        .from(rateSources)
        .where(and(eq(rateSources.tenantId, ctx.tenantId), eq(rateSources.id, sourceId)))
        .for('update');
      if (!source) throw Errors.notFound('Rate source');
      if (source.kind !== 'provider' || source.status !== 'active')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', 'Only an active provider source can be pulled');
      if (source.providerKey !== 'simulator')
        throw new AppError(409, 'CONNECTOR_UNAVAILABLE', 'This provider has no adapter in this build');
      const currency = await tenantCurrency(tx, ctx.tenantId);
      const skipped: { code: string; message: string }[] = [];
      const proposedIds: string[] = [];
      const now = new Date();
      const asOf = new Date(now.getTime() - input.asOfMinutesAgo * 60_000);
      const tick = Number.isInteger((source.adapterState as { tick?: unknown }).tick)
        ? ((source.adapterState as { tick: number }).tick ?? 0)
        : 0;
      if (currency !== 'INR') {
        skipped.push({ code: '*', message: 'The simulator only produces INR values' });
      } else {
        const purities = await tx
          .select()
          .from(purityDefinitions)
          .where(and(eq(purityDefinitions.tenantId, ctx.tenantId), eq(purityDefinitions.status, 'active')))
          .orderBy(asc(purityDefinitions.metal), asc(purityDefinitions.code));
        for (const p of purities) {
          const value = simulatorRateValue(p.metal, p.fineness, tick);
          if (!value) {
            skipped.push({ code: p.code, message: `No simulated value for ${p.metal}` });
            continue;
          }
          const [pending] = await tx
            .select({ n: count() })
            .from(metalRates)
            .where(
              and(
                eq(metalRates.tenantId, ctx.tenantId),
                eq(metalRates.sourceId, source.id),
                eq(metalRates.purityId, p.id),
                eq(metalRates.status, 'proposed'),
              ),
            );
          if (pending!.n > 0) {
            skipped.push({ code: p.code, message: 'A simulated proposal is already waiting for approval' });
            continue;
          }
          const [row] = await tx
            .insert(metalRates)
            .values({
              tenantId: ctx.tenantId,
              sourceId: source.id,
              metal: p.metal,
              purityId: p.id,
              currency,
              ratePerG: ratePerGram(value, 'per_g'),
              inputValue: value,
              inputUnit: 'per_g',
              sourceAsOf: asOf,
              reason: 'SIMULATED value from the rate simulator (test data, not a market rate)',
              proposedBy: auth.userId,
            })
            .returning({ id: metalRates.id });
          proposedIds.push(row!.id);
          await this.proposedEvent(tx, ctx, row!.id, p.code, value, meta);
        }
      }
      await tx
        .update(rateSources)
        .set({
          adapterState: { tick: tick + 1 },
          lastPulledAt: now,
          updatedAt: now,
          version: source.version + 1,
        })
        .where(eq(rateSources.id, source.id));
      await audit(tx, auth, ctx, meta, 'rates.pulled', 'rate_source', source.id, {
        newValues: { proposed: proposedIds.length, skipped: skipped.length, asOf: iso(asOf) },
      });
      const settings = await loadPricingSettings(tx, ctx.tenantId);
      const rows = proposedIds.length
        ? await tx
            .select()
            .from(metalRates)
            .where(
              and(
                eq(metalRates.tenantId, ctx.tenantId),
                eq(metalRates.sourceId, source.id),
                eq(metalRates.status, 'proposed'),
              ),
            )
        : [];
      return {
        proposed: await loadRates(
          tx,
          ctx.tenantId,
          rows.filter((r) => proposedIds.includes(r.id)),
          settings,
        ),
        skipped,
      };
    });
  }

  // ---------------------------------------------------------------- rates

  async list(ctx: TenantState, q: MetalRateListQuery): Promise<Page<MetalRate>> {
    requireMetalRates(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const where: (SQL | undefined)[] = [
        eq(metalRates.tenantId, ctx.tenantId),
        q.status ? eq(metalRates.status, q.status) : undefined,
        q.purityId ? eq(metalRates.purityId, q.purityId) : undefined,
      ];
      if (cursor) {
        const at = new Date(String(cursor.sortValue));
        where.push(
          or(lt(metalRates.proposedAt, at), and(eq(metalRates.proposedAt, at), lt(metalRates.id, cursor.id))),
        );
      }
      const rows = await tx
        .select()
        .from(metalRates)
        .where(and(...where))
        .orderBy(desc(metalRates.proposedAt), desc(metalRates.id))
        .limit(q.limit + 1);
      const settings = await loadPricingSettings(tx, ctx.tenantId);
      const page = paginate(rows, q.limit, (r) => iso(r.proposedAt));
      return { items: await loadRates(tx, ctx.tenantId, page.items, settings), nextCursor: page.nextCursor };
    });
  }

  async get(ctx: TenantState, id: string): Promise<MetalRate> {
    requireMetalRates(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const row = await this.load(tx, ctx, id);
      const settings = await loadPricingSettings(tx, ctx.tenantId);
      return (await loadRates(tx, ctx.tenantId, [row], settings))[0]!;
    });
  }

  async current(ctx: TenantState): Promise<CurrentRates> {
    requireMetalRates(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const settings = await loadPricingSettings(tx, ctx.tenantId);
      const currency = await tenantCurrency(tx, ctx.tenantId);
      const purities = await tx
        .select()
        .from(purityDefinitions)
        .where(and(eq(purityDefinitions.tenantId, ctx.tenantId), eq(purityDefinitions.status, 'active')))
        .orderBy(asc(purityDefinitions.metal), asc(purityDefinitions.code));
      const cur = await currentRates(tx, ctx.tenantId, currency);
      const pending = await tx
        .select({ purityId: metalRates.purityId, n: count() })
        .from(metalRates)
        .where(and(eq(metalRates.tenantId, ctx.tenantId), eq(metalRates.status, 'proposed')))
        .groupBy(metalRates.purityId);
      const mapped = await loadRates(tx, ctx.tenantId, [...cur.values()], settings);
      const byPurity = new Map(mapped.map((m) => [m.purity.id, m]));
      const now = Date.now();
      return {
        maxAgeMinutes: settings.rateMaxAgeMinutes,
        stalePolicy: settings.stalePolicy,
        items: purities.map((p) => {
          const rate = byPurity.get(p.id) ?? null;
          const row = cur.get(p.id);
          return {
            metal: p.metal,
            purity: { id: p.id, code: p.code, label: p.label },
            currency,
            rate,
            pending: pending.find((x) => x.purityId === p.id)?.n ?? 0,
            stale: row ? isStale(row, settings) : false,
            ageMinutes: row ? Math.floor((now - row.sourceAsOf.getTime()) / 60_000) : null,
          };
        }),
      };
    });
  }

  async propose(
    auth: AuthState,
    ctx: TenantState,
    input: ProposeRateRequest,
    meta: RequestMeta,
  ): Promise<MetalRate> {
    requireMetalRates(ctx);
    let perG: string;
    try {
      perG = ratePerGram(input.value, input.unit);
    } catch (e) {
      if (e instanceof PricingError) throw rateInvalid(e);
      throw e;
    }
    const now = new Date();
    const sourceAsOf = input.sourceAsOf ? new Date(input.sourceAsOf) : now;
    if (sourceAsOf.getTime() > now.getTime() + SKEW_MS)
      throw Errors.validation([{ path: 'sourceAsOf', message: 'The source time cannot be in the future' }]);
    const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : null;
    if (effectiveFrom && effectiveFrom.getTime() < now.getTime() - SKEW_MS)
      throw Errors.validation([
        {
          path: 'effectiveFrom',
          message: 'A rate cannot take effect in the past; leave it empty for "on approval"',
        },
      ]);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [purity] = await tx
        .select()
        .from(purityDefinitions)
        .where(and(eq(purityDefinitions.tenantId, ctx.tenantId), eq(purityDefinitions.id, input.purityId)));
      if (!purity) throw Errors.notFound('Purity');
      if (purity.status !== 'active')
        throw Errors.validation([{ path: 'purityId', message: 'This purity is inactive' }]);
      let source: SourceRow;
      if (input.sourceId) {
        const [s] = await tx
          .select()
          .from(rateSources)
          .where(and(eq(rateSources.tenantId, ctx.tenantId), eq(rateSources.id, input.sourceId)));
        if (!s) throw Errors.notFound('Rate source');
        if (s.kind !== 'manual')
          throw Errors.validation([
            {
              path: 'sourceId',
              message: 'Manual entries must use the manual source; provider values come from a pull',
            },
          ]);
        source = s;
      } else source = await manualSource(tx, ctx.tenantId);
      const currency = input.currency ?? (await tenantCurrency(tx, ctx.tenantId));
      const [row] = await tx
        .insert(metalRates)
        .values({
          tenantId: ctx.tenantId,
          sourceId: source.id,
          metal: purity.metal,
          purityId: purity.id,
          currency,
          ratePerG: perG,
          inputValue: input.value,
          inputUnit: input.unit,
          sourceAsOf,
          effectiveFrom,
          reason: input.reason,
          proposedBy: auth.userId,
        })
        .returning();
      await this.proposedEvent(tx, ctx, row!.id, purity.code, input.value, meta);
      await audit(tx, auth, ctx, meta, 'rates.proposed', 'metal_rate', row!.id, {
        newValues: { purity: purity.code, currency, value: input.value, unit: input.unit, ratePerG: perG },
        reason: input.reason,
      });
      const settings = await loadPricingSettings(tx, ctx.tenantId);
      return (await loadRates(tx, ctx.tenantId, [row!], settings))[0]!;
    });
  }

  async approve(auth: AuthState, ctx: TenantState, id: string, input: ApproveRateRequest, meta: RequestMeta) {
    requireMetalRates(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const row = await this.load(tx, ctx, id, true);
      if (row.status !== 'proposed')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', `This rate is already ${row.status}`);
      if (row.proposedBy === auth.userId)
        throw new AppError(
          403,
          'SEPARATION_OF_DUTIES',
          'You proposed this rate; another approver must approve it',
        );
      const now = new Date();
      const effectiveFrom = row.effectiveFrom ?? now;
      const [after] = await tx
        .update(metalRates)
        .set({
          status: 'approved',
          decidedBy: auth.userId,
          decidedAt: now,
          decisionNote: input.note ?? null,
          effectiveFrom,
        })
        .where(eq(metalRates.id, row.id))
        .returning();
      const payload = {
        rateId: row.id,
        purityId: row.purityId,
        currency: row.currency,
        ratePerG: row.ratePerG,
        effectiveFrom: iso(effectiveFrom),
      };
      await enqueueEvent(tx, {
        tenantId: ctx.tenantId,
        eventType: 'RateApproved',
        aggregateType: 'metal_rate',
        aggregateId: row.id,
        correlationId: meta.correlationId,
        payload,
      });
      if (effectiveFrom.getTime() <= now.getTime())
        await enqueueEvent(tx, {
          tenantId: ctx.tenantId,
          eventType: 'RatePublished',
          aggregateType: 'metal_rate',
          aggregateId: row.id,
          correlationId: meta.correlationId,
          payload,
        });
      await audit(tx, auth, ctx, meta, 'rates.approved', 'metal_rate', row.id, {
        oldValues: { status: 'proposed' },
        newValues: { status: 'approved', ratePerG: row.ratePerG, effectiveFrom: iso(effectiveFrom) },
        reason: input.note ?? null,
      });
      const settings = await loadPricingSettings(tx, ctx.tenantId);
      return (await loadRates(tx, ctx.tenantId, [after!], settings))[0]!;
    });
  }

  async reject(auth: AuthState, ctx: TenantState, id: string, input: RejectRateRequest, meta: RequestMeta) {
    requireMetalRates(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const row = await this.load(tx, ctx, id, true);
      if (row.status !== 'proposed')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', `This rate is already ${row.status}`);
      const [after] = await tx
        .update(metalRates)
        .set({
          status: 'rejected',
          decidedBy: row.proposedBy === auth.userId ? null : auth.userId,
          decidedAt: new Date(),
          decisionNote: input.reason,
        })
        .where(eq(metalRates.id, row.id))
        .returning();
      await audit(tx, auth, ctx, meta, 'rates.rejected', 'metal_rate', row.id, {
        oldValues: { status: 'proposed' },
        newValues: { status: 'rejected' },
        reason: input.reason,
      });
      const settings = await loadPricingSettings(tx, ctx.tenantId);
      return (await loadRates(tx, ctx.tenantId, [after!], settings))[0]!;
    });
  }

  private async load(tx: Tx, ctx: TenantState, id: string, lock = false): Promise<RateRow> {
    const q = tx
      .select()
      .from(metalRates)
      .where(and(eq(metalRates.tenantId, ctx.tenantId), eq(metalRates.id, id)));
    const [row] = lock ? await q.for('update') : await q;
    if (!row) throw Errors.notFound('Metal rate');
    return row;
  }

  private proposedEvent(
    tx: Tx,
    ctx: TenantState,
    id: string,
    purity: string,
    value: string,
    meta: RequestMeta,
  ) {
    return enqueueEvent(tx, {
      tenantId: ctx.tenantId,
      eventType: 'RateProposed',
      aggregateType: 'metal_rate',
      aggregateId: id,
      correlationId: meta.correlationId,
      payload: { rateId: id, purity, value },
    });
  }
}
