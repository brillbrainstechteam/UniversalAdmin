import { Injectable } from '@nestjs/common';
import {
  compareGrams,
  gramsToCarats,
  STONE_KINDS,
  type Component,
  type CreatePurityRequest,
  type JewellerySettings,
  type JewellerySpec,
  type ProductJewellery,
  type PurityDefinition,
  type PutJewellerySpecRequest,
  type UpdateJewellerySettingsRequest,
  type UpdatePurityRequest,
} from '@uc/contracts';
import {
  diff,
  jewelleryComponents,
  jewellerySettings,
  jewellerySpecs,
  products,
  purityDefinitions,
  serialItems,
  variants,
  writeAudit,
  type Tx,
} from '@uc/db';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { Errors } from '../../common/errors';
import { iso } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';
import {
  Issues,
  measurementChecks,
  normalizeComponents,
  notJewellery,
  resolveFine,
  type NormalizedComponent,
  type PurityInfo,
  type Settings,
} from './measurements';

type ComponentRow = typeof jewelleryComponents.$inferSelect;
type SpecRow = typeof jewellerySpecs.$inferSelect;
type PurityRow = typeof purityDefinitions.$inferSelect;

export const purityInfo = (p: PurityRow): PurityInfo => ({
  id: p.id,
  metal: p.metal,
  code: p.code,
  label: p.label,
  fineness: p.fineness,
  confirmed: p.source === 'merchant' || p.confirmedAt !== null,
  status: p.status,
});
export const purityRef = (p: PurityInfo) => ({
  id: p.id,
  code: p.code,
  label: p.label,
  fineness: p.fineness,
  confirmed: p.confirmed,
});

/** Shared readers used by spec, item and catalog code paths (all tenant-scoped). */
export async function loadSettings(tx: Tx, tenantId: string): Promise<Settings> {
  const [row] = await tx.select().from(jewellerySettings).where(eq(jewellerySettings.tenantId, tenantId));
  if (!row) return { weightToleranceG: '0.010000', fineScale: 3, huidFormat: 'bis_6_alnum' };
  return { weightToleranceG: row.weightToleranceG, fineScale: row.fineScale, huidFormat: row.huidFormat };
}

export async function loadPurities(tx: Tx, tenantId: string): Promise<Map<string, PurityInfo>> {
  const rows = await tx.select().from(purityDefinitions).where(eq(purityDefinitions.tenantId, tenantId));
  return new Map(rows.map((r) => [r.id, purityInfo(r)]));
}

export function toComponent(c: ComponentRow, purities: Map<string, PurityInfo>): Component {
  const purity = c.purityId ? purities.get(c.purityId) : undefined;
  return {
    id: c.id,
    kind: c.kind,
    description: c.description,
    shape: c.shape,
    grade: c.grade,
    count: c.count,
    weightG: c.weightG,
    caratWeight: (STONE_KINDS as readonly string[]).includes(c.kind) ? gramsToCarats(c.weightG) : null,
    purity: purity ? purityRef(purity) : null,
    certificate: c.certificate,
    raw: c.raw as Record<string, unknown>,
  };
}

export function componentValues(
  tenantId: string,
  owner: { specId?: string; itemId?: string },
  list: NormalizedComponent[],
) {
  return list.map((c, position) => ({
    tenantId,
    specId: owner.specId ?? null,
    itemId: owner.itemId ?? null,
    kind: c.kind,
    description: c.description,
    shape: c.shape,
    grade: c.grade,
    count: c.count,
    weightG: c.weightG,
    metal: c.metal as (typeof jewelleryComponents.$inferInsert)['metal'],
    purityId: c.purityId,
    certificate: c.certificate,
    position,
    raw: c.raw,
  }));
}

function toSpec(
  spec: SpecRow,
  components: ComponentRow[],
  purities: Map<string, PurityInfo>,
  settings: Settings,
): JewellerySpec {
  const purity = purities.get(spec.purityId)!;
  return {
    id: spec.id,
    variantId: spec.variantId,
    metal: spec.metal,
    purity: purityRef(purity),
    colour: spec.colour,
    grossG: spec.grossG,
    netG: spec.netG,
    stoneG: spec.stoneG,
    fineG: spec.fineG,
    fineSource: spec.fineSource,
    billingBasis: spec.billingBasis,
    qtyUnit: spec.qtyUnit,
    piecesPerUnit: spec.piecesPerUnit,
    components: components.map((c) => toComponent(c, purities)),
    raw: spec.raw as Record<string, unknown>,
    checks: measurementChecks(spec, purity, components, purities, settings),
    version: spec.version,
    updatedAt: iso(spec.updatedAt),
  };
}

/** Jewellery block for the product detail (null for standard products). */
export async function loadProductJewellery(
  tx: Tx,
  ctx: TenantState,
  productId: string,
  productType: string,
): Promise<ProductJewellery | null> {
  if (productType !== 'jewellery') return null;
  const variantRows = await tx
    .select({ id: variants.id })
    .from(variants)
    .where(eq(variants.productId, productId));
  const ids = variantRows.map((v) => v.id);
  if (ids.length === 0) return { specs: [], serialItemCounts: {} };
  const specs = await tx
    .select()
    .from(jewellerySpecs)
    .where(and(eq(jewellerySpecs.tenantId, ctx.tenantId), inArray(jewellerySpecs.variantId, ids)));
  const comps = specs.length
    ? await tx
        .select()
        .from(jewelleryComponents)
        .where(
          inArray(
            jewelleryComponents.specId,
            specs.map((s) => s.id),
          ),
        )
        .orderBy(asc(jewelleryComponents.position))
    : [];
  const counts = await tx
    .select({ variantId: serialItems.variantId, n: count() })
    .from(serialItems)
    .where(and(eq(serialItems.tenantId, ctx.tenantId), inArray(serialItems.variantId, ids)))
    .groupBy(serialItems.variantId);
  const purities = await loadPurities(tx, ctx.tenantId);
  const settings = await loadSettings(tx, ctx.tenantId);
  return {
    specs: specs.map((s) =>
      toSpec(
        s,
        comps.filter((c) => c.specId === s.id),
        purities,
        settings,
      ),
    ),
    serialItemCounts: Object.fromEntries(counts.map((c) => [c.variantId, c.n])),
  };
}

@Injectable()
export class JewelleryService {
  constructor(private readonly db: DbService) {}

  private requireFeature(ctx: TenantState) {
    if (!ctx.features.includes('jewellery')) throw Errors.featureNotEntitled('jewellery');
  }

  private audit(
    tx: Tx,
    auth: AuthState,
    ctx: TenantState,
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
      actorType: 'user',
      actorUserId: auth.userId,
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

  // ---------------------------------------------------------------- settings

  private toSettings(row: typeof jewellerySettings.$inferSelect): JewellerySettings {
    return {
      weightToleranceG: row.weightToleranceG,
      fineScale: row.fineScale,
      huidFormat: row.huidFormat,
      version: row.version,
      updatedAt: iso(row.updatedAt),
    };
  }

  async getSettings(ctx: TenantState): Promise<JewellerySettings> {
    this.requireFeature(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await tx.insert(jewellerySettings).values({ tenantId: ctx.tenantId }).onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(jewellerySettings)
        .where(eq(jewellerySettings.tenantId, ctx.tenantId));
      return this.toSettings(row!);
    });
  }

  async updateSettings(
    auth: AuthState,
    ctx: TenantState,
    input: UpdateJewellerySettingsRequest,
    meta: RequestMeta,
  ): Promise<JewellerySettings> {
    this.requireFeature(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await tx.insert(jewellerySettings).values({ tenantId: ctx.tenantId }).onConflictDoNothing();
      const [before] = await tx
        .select()
        .from(jewellerySettings)
        .where(eq(jewellerySettings.tenantId, ctx.tenantId))
        .for('update');
      if (before!.version !== input.version) throw Errors.versionConflict(before!.version);
      const { version, ...changes } = input;
      const [after] = await tx
        .update(jewellerySettings)
        .set({ ...changes, version: version + 1, updatedAt: new Date() })
        .where(eq(jewellerySettings.tenantId, ctx.tenantId))
        .returning();
      await this.audit(
        tx,
        auth,
        ctx,
        meta,
        'jewellery.settings_updated',
        'jewellery_settings',
        ctx.tenantId,
        diff(this.toSettings(before!), this.toSettings(after!)),
      );
      return this.toSettings(after!);
    });
  }

  // ---------------------------------------------------------------- purities

  private toPurity(p: PurityRow): PurityDefinition {
    return {
      id: p.id,
      metal: p.metal,
      code: p.code,
      label: p.label,
      fineness: p.fineness,
      status: p.status,
      source: p.source,
      confirmedAt: p.confirmedAt ? iso(p.confirmedAt) : null,
      version: p.version,
      updatedAt: iso(p.updatedAt),
    };
  }

  async listPurities(ctx: TenantState): Promise<{ items: PurityDefinition[] }> {
    this.requireFeature(ctx);
    const rows = await this.db.tenant(ctx.tenantId, (tx) =>
      tx
        .select()
        .from(purityDefinitions)
        .where(eq(purityDefinitions.tenantId, ctx.tenantId))
        .orderBy(asc(purityDefinitions.metal), asc(purityDefinitions.code)),
    );
    return { items: rows.map((r) => this.toPurity(r)) };
  }

  async createPurity(
    auth: AuthState,
    ctx: TenantState,
    input: CreatePurityRequest,
    meta: RequestMeta,
  ): Promise<PurityDefinition> {
    this.requireFeature(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .insert(purityDefinitions)
        .values({
          tenantId: ctx.tenantId,
          ...input,
          source: 'merchant',
          confirmedBy: auth.userId,
          confirmedAt: new Date(),
        })
        .returning();
      await this.audit(tx, auth, ctx, meta, 'jewellery.purity_created', 'purity_definition', row!.id, {
        newValues: this.toPurity(row!),
      });
      return this.toPurity(row!);
    });
  }

  async updatePurity(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: UpdatePurityRequest,
    meta: RequestMeta,
  ): Promise<PurityDefinition> {
    this.requireFeature(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [before] = await tx
        .select()
        .from(purityDefinitions)
        .where(and(eq(purityDefinitions.tenantId, ctx.tenantId), eq(purityDefinitions.id, id)))
        .for('update');
      if (!before) throw Errors.notFound('Purity');
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      const confirm = input.confirm || input.fineness !== undefined;
      const [after] = await tx
        .update(purityDefinitions)
        .set({
          label: input.label ?? before.label,
          fineness: input.fineness ?? before.fineness,
          status: input.status ?? before.status,
          confirmedBy: confirm ? auth.userId : before.confirmedBy,
          confirmedAt: confirm ? new Date() : before.confirmedAt,
          version: before.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(purityDefinitions.id, id))
        .returning();
      // Existing measurements keep their stored fine weight and formula inputs (snapshot); only future
      // computations use the new fineness.
      await this.audit(
        tx,
        auth,
        ctx,
        meta,
        input.confirm ? 'jewellery.purity_confirmed' : 'jewellery.purity_updated',
        'purity_definition',
        id,
        diff(this.toPurity(before), this.toPurity(after!)),
      );
      return this.toPurity(after!);
    });
  }

  // ---------------------------------------------------------------- variant spec

  private async jewelleryVariant(tx: Tx, ctx: TenantState, productId: string, variantId: string) {
    const [row] = await tx
      .select({ variantId: variants.id, productType: products.productType })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(
        and(
          eq(variants.tenantId, ctx.tenantId),
          eq(variants.id, variantId),
          eq(variants.productId, productId),
        ),
      );
    if (!row) throw Errors.notFound('Variant');
    if (row.productType !== 'jewellery') throw notJewellery();
    return row;
  }

  async getSpec(ctx: TenantState, productId: string, variantId: string): Promise<JewellerySpec> {
    this.requireFeature(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await this.jewelleryVariant(tx, ctx, productId, variantId);
      const [spec] = await tx
        .select()
        .from(jewellerySpecs)
        .where(and(eq(jewellerySpecs.tenantId, ctx.tenantId), eq(jewellerySpecs.variantId, variantId)));
      if (!spec) throw Errors.notFound('Jewellery spec');
      const comps = await tx
        .select()
        .from(jewelleryComponents)
        .where(eq(jewelleryComponents.specId, spec.id))
        .orderBy(asc(jewelleryComponents.position));
      return toSpec(spec, comps, await loadPurities(tx, ctx.tenantId), await loadSettings(tx, ctx.tenantId));
    });
  }

  async putSpec(
    auth: AuthState,
    ctx: TenantState,
    productId: string,
    variantId: string,
    input: PutJewellerySpecRequest,
    meta: RequestMeta,
  ): Promise<JewellerySpec> {
    this.requireFeature(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await this.jewelleryVariant(tx, ctx, productId, variantId);
      const purities = await loadPurities(tx, ctx.tenantId);
      const settings = await loadSettings(tx, ctx.tenantId);
      const issues = new Issues();
      const purity = purities.get(input.purityId);
      if (!purity || purity.status !== 'active') issues.add('purityId', 'Unknown or inactive purity');
      const grossG = issues.grams('gross', input.gross);
      const netG = issues.grams('net', input.net);
      const stoneG = issues.grams('stone', input.stone);
      if (input.gross?.unit === 'ct' || input.net?.unit === 'ct' || input.fine?.unit === 'ct')
        issues.add('unit', 'Carats are only valid for stone weights');
      if (grossG && netG && compareGrams(netG, grossG) > 0) {
        issues.add('net', 'Design net weight cannot exceed gross weight');
      }
      const components = normalizeComponents(issues, 'components', input.components, purities);
      issues.throwIfAny();
      const fine = resolveFine(issues, 'fine', input.fine, netG, purity!, components, purities, settings);
      issues.throwIfAny();

      const [existing] = await tx
        .select()
        .from(jewellerySpecs)
        .where(and(eq(jewellerySpecs.tenantId, ctx.tenantId), eq(jewellerySpecs.variantId, variantId)))
        .for('update');
      if (existing && input.version === undefined)
        throw Errors.validation([
          { path: 'version', message: 'version is required to update an existing spec' },
        ]);
      if (existing && existing.version !== input.version) throw Errors.versionConflict(existing.version);
      const values = {
        metal: purity!.metal as SpecRow['metal'],
        purityId: purity!.id,
        colour: input.colour ?? null,
        grossG,
        netG,
        stoneG,
        fineG: fine.fineG,
        fineSource: fine.source,
        billingBasis: input.billingBasis,
        qtyUnit: input.qtyUnit,
        piecesPerUnit: input.piecesPerUnit,
        raw: {
          gross: input.gross ?? null,
          net: input.net ?? null,
          stone: input.stone ?? null,
          fine: input.fine ?? null,
          fineFormula: fine.formula,
          source: 'manual',
        },
      };
      let spec: SpecRow;
      if (existing) {
        [spec] = (await tx
          .update(jewellerySpecs)
          .set({ ...values, version: existing.version + 1, updatedAt: new Date() })
          .where(eq(jewellerySpecs.id, existing.id))
          .returning()) as [SpecRow];
        await tx.delete(jewelleryComponents).where(eq(jewelleryComponents.specId, existing.id));
      } else {
        [spec] = (await tx
          .insert(jewellerySpecs)
          .values({ tenantId: ctx.tenantId, variantId, ...values })
          .returning()) as [SpecRow];
      }
      if (components.length)
        await tx
          .insert(jewelleryComponents)
          .values(componentValues(ctx.tenantId, { specId: spec.id }, components));
      const comps = await tx
        .select()
        .from(jewelleryComponents)
        .where(eq(jewelleryComponents.specId, spec.id))
        .orderBy(asc(jewelleryComponents.position));
      const result = toSpec(spec, comps, purities, settings);
      const snapshot = (s: SpecRow | undefined) =>
        s
          ? {
              purityId: s.purityId,
              grossG: s.grossG,
              netG: s.netG,
              stoneG: s.stoneG,
              fineG: s.fineG,
              fineSource: s.fineSource,
              billingBasis: s.billingBasis,
              qtyUnit: s.qtyUnit,
              piecesPerUnit: s.piecesPerUnit,
            }
          : null;
      await this.audit(
        tx,
        auth,
        ctx,
        meta,
        existing ? 'jewellery_spec.updated' : 'jewellery_spec.created',
        'jewellery_spec',
        spec.id,
        {
          ...(existing ? diff(snapshot(existing), snapshot(spec)) : { newValues: snapshot(spec) }),
        },
      );
      await tx.update(products).set({ updatedAt: new Date() }).where(eq(products.id, productId));
      return result;
    });
  }
}
