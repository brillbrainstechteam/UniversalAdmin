import { Injectable } from '@nestjs/common';
import {
  RuleConditions,
  RuleDefinition,
  conditionsOverlap,
  type CreatePriceBookRequest,
  type CreatePriceRuleRequest,
  type CreateTaxRuleRequest,
  type PriceBook,
  type PriceRule,
  type PriceRuleVersion,
  type PricingCatalogOptions,
  type PricingSettings,
  type PublishRuleRequest,
  type PutListPricesRequest,
  type RetireRuleRequest,
  type SaveRuleDraftRequest,
  type TaxRule,
  type UpdatePriceBookRequest,
  type UpdatePricingSettingsRequest,
  type UpdateTaxRuleRequest,
} from '@uc/contracts';
import {
  categories,
  channels,
  diff,
  enqueueEvent,
  priceBooks,
  priceListEntries,
  priceRules,
  priceRuleVersions,
  pricingSettings,
  products,
  purityDefinitions,
  taxRules,
  users,
  variants,
  type Tx,
} from '@uc/db';
import { and, asc, count, desc, eq, inArray, max, ne, sql } from 'drizzle-orm';
import { AppError, Errors } from '../../common/errors';
import { iso } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';
import { audit, loadPricingSettings, requirePricing, tenantCurrency, toSettings } from './pricing.common';

type BookRow = typeof priceBooks.$inferSelect;
type TaxRow = typeof taxRules.$inferSelect;
type VersionRow = typeof priceRuleVersions.$inferSelect;
type RuleRow = typeof priceRules.$inferSelect;

function toTax(t: TaxRow): TaxRule {
  return {
    id: t.id,
    label: t.label,
    ratePercent: t.ratePercent,
    appliesTo: t.appliesTo as TaxRule['appliesTo'],
    status: t.status,
    validationNote: t.validationNote,
    version: t.version,
    updatedAt: iso(t.updatedAt),
  };
}

@Injectable()
export class PricingService {
  constructor(private readonly db: DbService) {}

  // ---------------------------------------------------------------- settings & options

  async settings(ctx: TenantState): Promise<PricingSettings> {
    requirePricing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) =>
      toSettings(await loadPricingSettings(tx, ctx.tenantId)),
    );
  }

  async updateSettings(
    auth: AuthState,
    ctx: TenantState,
    input: UpdatePricingSettingsRequest,
    meta: RequestMeta,
  ) {
    requirePricing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await loadPricingSettings(tx, ctx.tenantId);
      const [before] = await tx
        .select()
        .from(pricingSettings)
        .where(eq(pricingSettings.tenantId, ctx.tenantId))
        .for('update');
      if (before!.version !== input.version) throw Errors.versionConflict(before!.version);
      const { version, ...changes } = input;
      const [after] = await tx
        .update(pricingSettings)
        .set({ ...changes, version: version + 1, updatedAt: new Date() })
        .where(eq(pricingSettings.tenantId, ctx.tenantId))
        .returning();
      await audit(
        tx,
        auth,
        ctx,
        meta,
        'pricing.settings_updated',
        'pricing_settings',
        ctx.tenantId,
        diff(toSettings(before!), toSettings(after!)),
      );
      return toSettings(after!);
    });
  }

  async options(ctx: TenantState): Promise<PricingCatalogOptions> {
    requirePricing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [purities, chans, taxes, currency] = await Promise.all([
        tx
          .select({
            id: purityDefinitions.id,
            metal: purityDefinitions.metal,
            code: purityDefinitions.code,
            label: purityDefinitions.label,
          })
          .from(purityDefinitions)
          .where(and(eq(purityDefinitions.tenantId, ctx.tenantId), eq(purityDefinitions.status, 'active')))
          .orderBy(asc(purityDefinitions.metal), asc(purityDefinitions.code)),
        tx
          .select({ id: channels.id, name: channels.name })
          .from(channels)
          .where(eq(channels.tenantId, ctx.tenantId))
          .orderBy(asc(channels.name)),
        tx
          .select({ id: taxRules.id, label: taxRules.label, status: taxRules.status })
          .from(taxRules)
          .where(eq(taxRules.tenantId, ctx.tenantId))
          .orderBy(asc(taxRules.label)),
        tenantCurrency(tx, ctx.tenantId),
      ]);
      return {
        purities: ctx.features.includes('jewellery') ? purities : [],
        channels: chans,
        taxRules: taxes,
        currency,
      };
    });
  }

  // ---------------------------------------------------------------- tax rules

  async taxRules(ctx: TenantState): Promise<{ items: TaxRule[] }> {
    requirePricing(ctx);
    const rows = await this.db.tenant(ctx.tenantId, (tx) =>
      tx.select().from(taxRules).where(eq(taxRules.tenantId, ctx.tenantId)).orderBy(asc(taxRules.label)),
    );
    return { items: rows.map(toTax) };
  }

  async createTaxRule(auth: AuthState, ctx: TenantState, input: CreateTaxRuleRequest, meta: RequestMeta) {
    requirePricing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .insert(taxRules)
        .values({
          tenantId: ctx.tenantId,
          label: input.label,
          ratePercent: input.ratePercent,
          appliesTo: [...new Set(input.appliesTo)],
        })
        .returning();
      await audit(tx, auth, ctx, meta, 'pricing.tax_rule_created', 'tax_rule', row!.id, {
        newValues: toTax(row!),
      });
      return toTax(row!);
    });
  }

  async updateTaxRule(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: UpdateTaxRuleRequest,
    meta: RequestMeta,
  ) {
    requirePricing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [before] = await tx
        .select()
        .from(taxRules)
        .where(and(eq(taxRules.tenantId, ctx.tenantId), eq(taxRules.id, id)))
        .for('update');
      if (!before) throw Errors.notFound('Tax rule');
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      const { version, appliesTo, ...rest } = input;
      const validating = input.status === 'validated' && before.status !== 'validated';
      // Any change to the rate or scope needs validating again.
      const changedSubstance =
        (input.ratePercent !== undefined && input.ratePercent !== before.ratePercent) ||
        appliesTo !== undefined;
      const [after] = await tx
        .update(taxRules)
        .set({
          ...rest,
          ...(appliesTo ? { appliesTo: [...new Set(appliesTo)] } : {}),
          ...(validating ? { validatedBy: auth.userId, validatedAt: new Date() } : {}),
          ...(changedSubstance && !validating && before.status === 'validated'
            ? { status: 'pending_validation' as const, validatedBy: null, validatedAt: null }
            : {}),
          version: version + 1,
          updatedAt: new Date(),
        })
        .where(eq(taxRules.id, id))
        .returning();
      await audit(
        tx,
        auth,
        ctx,
        meta,
        'pricing.tax_rule_updated',
        'tax_rule',
        id,
        diff(toTax(before), toTax(after!)),
      );
      return toTax(after!);
    });
  }

  // ---------------------------------------------------------------- books

  private async books(tx: Tx, tenantId: string, ids?: string[]): Promise<PriceBook[]> {
    const rows = await tx
      .select({ b: priceBooks, channelName: channels.name })
      .from(priceBooks)
      .leftJoin(channels, eq(channels.id, priceBooks.channelId))
      .where(and(eq(priceBooks.tenantId, tenantId), ids ? inArray(priceBooks.id, ids) : undefined))
      .orderBy(asc(priceBooks.status), desc(priceBooks.priority), asc(priceBooks.name));
    if (!rows.length) return [];
    const bookIds = rows.map((r) => r.b.id);
    const [ruleCounts, priceCounts] = await Promise.all([
      tx
        .select({ id: priceRules.bookId, n: count() })
        .from(priceRules)
        .where(and(inArray(priceRules.bookId, bookIds), eq(priceRules.status, 'active')))
        .groupBy(priceRules.bookId),
      tx
        .select({ id: priceListEntries.bookId, n: count() })
        .from(priceListEntries)
        .where(inArray(priceListEntries.bookId, bookIds))
        .groupBy(priceListEntries.bookId),
    ]);
    return rows.map(({ b, channelName }) => ({
      id: b.id,
      name: b.name,
      channel: b.channelId ? { id: b.channelId, name: channelName ?? '' } : null,
      priority: b.priority,
      currency: b.currency,
      status: b.status,
      effectiveFrom: b.effectiveFrom ? iso(b.effectiveFrom) : null,
      effectiveTo: b.effectiveTo ? iso(b.effectiveTo) : null,
      ruleCount: ruleCounts.find((c) => c.id === b.id)?.n ?? 0,
      listPriceCount: priceCounts.find((c) => c.id === b.id)?.n ?? 0,
      version: b.version,
      updatedAt: iso(b.updatedAt),
    }));
  }

  async listBooks(ctx: TenantState): Promise<{ items: PriceBook[] }> {
    requirePricing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => ({ items: await this.books(tx, ctx.tenantId) }));
  }

  async getBook(ctx: TenantState, id: string): Promise<PriceBook> {
    requirePricing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [book] = await this.books(tx, ctx.tenantId, [id]);
      if (!book) throw Errors.notFound('Price book');
      return book;
    });
  }

  private async checkChannel(tx: Tx, tenantId: string, channelId: string | null | undefined) {
    if (!channelId) return;
    const [c] = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.tenantId, tenantId), eq(channels.id, channelId)));
    if (!c) throw Errors.validation([{ path: 'channelId', message: 'Unknown channel' }]);
  }

  private checkWindow(from: string | null | undefined, to: string | null | undefined) {
    if (from && to && new Date(to) <= new Date(from))
      throw Errors.validation([{ path: 'effectiveTo', message: 'The end must be after the start' }]);
  }

  async createBook(auth: AuthState, ctx: TenantState, input: CreatePriceBookRequest, meta: RequestMeta) {
    requirePricing(ctx);
    this.checkWindow(input.effectiveFrom, input.effectiveTo);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await this.checkChannel(tx, ctx.tenantId, input.channelId);
      const [row] = await tx
        .insert(priceBooks)
        .values({
          tenantId: ctx.tenantId,
          name: input.name,
          channelId: input.channelId ?? null,
          priority: input.priority ?? 0,
          currency: input.currency ?? (await tenantCurrency(tx, ctx.tenantId)),
          effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : null,
          effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
          createdBy: auth.userId,
        })
        .returning();
      await audit(tx, auth, ctx, meta, 'pricing.book_created', 'price_book', row!.id, {
        newValues: {
          name: row!.name,
          channelId: row!.channelId,
          priority: row!.priority,
          currency: row!.currency,
        },
      });
      return (await this.books(tx, ctx.tenantId, [row!.id]))[0]!;
    });
  }

  async updateBook(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: UpdatePriceBookRequest,
    meta: RequestMeta,
  ) {
    requirePricing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [before] = await tx
        .select()
        .from(priceBooks)
        .where(and(eq(priceBooks.tenantId, ctx.tenantId), eq(priceBooks.id, id)))
        .for('update');
      if (!before) throw Errors.notFound('Price book');
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      await this.checkChannel(tx, ctx.tenantId, input.channelId);
      const from =
        input.effectiveFrom !== undefined
          ? input.effectiveFrom
          : before.effectiveFrom
            ? iso(before.effectiveFrom)
            : null;
      const to =
        input.effectiveTo !== undefined
          ? input.effectiveTo
          : before.effectiveTo
            ? iso(before.effectiveTo)
            : null;
      this.checkWindow(from, to);
      const { version, effectiveFrom, effectiveTo, ...rest } = input;
      await tx
        .update(priceBooks)
        .set({
          ...rest,
          ...(effectiveFrom !== undefined
            ? { effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : null }
            : {}),
          ...(effectiveTo !== undefined ? { effectiveTo: effectiveTo ? new Date(effectiveTo) : null } : {}),
          version: version + 1,
          updatedAt: new Date(),
        })
        .where(eq(priceBooks.id, id));
      const after = (await this.books(tx, ctx.tenantId, [id]))[0]!;
      await audit(tx, auth, ctx, meta, 'pricing.book_updated', 'price_book', id, {
        oldValues: {
          name: before.name,
          channelId: before.channelId,
          priority: before.priority,
          status: before.status,
        },
        newValues: {
          name: after.name,
          channelId: after.channel?.id ?? null,
          priority: after.priority,
          status: after.status,
        },
      });
      return after;
    });
  }

  private async loadBook(tx: Tx, tenantId: string, id: string): Promise<BookRow> {
    const [b] = await tx
      .select()
      .from(priceBooks)
      .where(and(eq(priceBooks.tenantId, tenantId), eq(priceBooks.id, id)));
    if (!b) throw Errors.notFound('Price book');
    return b;
  }

  async listPrices(ctx: TenantState, bookId: string) {
    requirePricing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await this.loadBook(tx, ctx.tenantId, bookId);
      const rows = await tx
        .select({ e: priceListEntries, sku: variants.sku, title: products.title })
        .from(priceListEntries)
        .innerJoin(variants, eq(variants.id, priceListEntries.variantId))
        .innerJoin(products, eq(products.id, variants.productId))
        .where(eq(priceListEntries.bookId, bookId))
        .orderBy(asc(variants.sku));
      return {
        items: rows.map((r) => ({
          variantId: r.e.variantId,
          sku: r.sku,
          productTitle: r.title,
          amount: r.e.amount,
          minQuantity: r.e.minQuantity,
          updatedAt: iso(r.e.updatedAt),
        })),
      };
    });
  }

  async putListPrices(
    auth: AuthState,
    ctx: TenantState,
    bookId: string,
    input: PutListPricesRequest,
    meta: RequestMeta,
  ) {
    requirePricing(ctx);
    const ids = input.items.map((i) => i.variantId);
    if (new Set(ids).size !== ids.length)
      throw Errors.validation([{ path: 'items', message: 'A variant appears twice' }]);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const book = await this.loadBook(tx, ctx.tenantId, bookId);
      if (book.status !== 'active')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', 'This price book is archived');
      const found = await tx
        .select({ id: variants.id })
        .from(variants)
        .where(and(eq(variants.tenantId, ctx.tenantId), inArray(variants.id, ids)));
      if (found.length !== ids.length)
        throw Errors.validation([{ path: 'items', message: 'Some variants do not exist' }]);
      const before = await tx
        .select()
        .from(priceListEntries)
        .where(and(eq(priceListEntries.bookId, bookId), inArray(priceListEntries.variantId, ids)));
      const remove = input.items.filter((i) => i.amount === null).map((i) => i.variantId);
      const upsert = input.items.filter((i) => i.amount !== null);
      if (remove.length)
        await tx
          .delete(priceListEntries)
          .where(and(eq(priceListEntries.bookId, bookId), inArray(priceListEntries.variantId, remove)));
      if (upsert.length)
        await tx
          .insert(priceListEntries)
          .values(
            upsert.map((i) => ({
              tenantId: ctx.tenantId,
              bookId,
              variantId: i.variantId,
              amount: i.amount!,
              minQuantity: i.minQuantity ?? null,
              updatedBy: auth.userId,
            })),
          )
          .onConflictDoUpdate({
            target: [priceListEntries.bookId, priceListEntries.variantId],
            set: {
              amount: sql`excluded.amount`,
              minQuantity: sql`excluded.min_quantity`,
              updatedBy: auth.userId,
              updatedAt: new Date(),
            },
          });
      await audit(tx, auth, ctx, meta, 'pricing.list_prices_updated', 'price_book', bookId, {
        oldValues: Object.fromEntries(before.map((b) => [b.variantId, b.amount])),
        newValues: Object.fromEntries(input.items.map((i) => [i.variantId, i.amount])),
      });
      return { updated: upsert.length, removed: remove.length };
    });
  }

  // ---------------------------------------------------------------- rules

  private toVersion(v: VersionRow, names: Map<string, string>): PriceRuleVersion {
    const actor = (id: string | null) => (id ? { id, name: names.get(id) ?? 'Unknown' } : null);
    return {
      id: v.id,
      version: v.version,
      status: v.status,
      priority: v.priority,
      conditions: RuleConditions.parse(v.conditions),
      definition: RuleDefinition.parse(v.definition),
      notes: v.notes,
      createdBy: actor(v.createdBy),
      createdAt: iso(v.createdAt),
      publishedBy: actor(v.publishedBy),
      publishedAt: v.publishedAt ? iso(v.publishedAt) : null,
      lockVersion: v.lockVersion,
    };
  }

  private async ruleDetail(tx: Tx, rule: RuleRow): Promise<PriceRule> {
    const versions = await tx
      .select()
      .from(priceRuleVersions)
      .where(eq(priceRuleVersions.ruleId, rule.id))
      .orderBy(desc(priceRuleVersions.version));
    const ids = [
      ...new Set(versions.flatMap((v) => [v.createdBy, v.publishedBy]).filter((x): x is string => !!x)),
    ];
    const people = ids.length
      ? await tx.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, ids))
      : [];
    const names = new Map(people.map((p) => [p.id, p.name]));
    const mapped = versions.map((v) => this.toVersion(v, names));
    const published = mapped.find((v) => v.status === 'published') ?? null;
    return {
      id: rule.id,
      bookId: rule.bookId,
      name: rule.name,
      status: rule.status === 'retired' ? 'retired' : published ? 'published' : 'draft_only',
      published,
      draft: mapped.find((v) => v.status === 'draft') ?? null,
      versions: mapped,
    };
  }

  private async loadRule(tx: Tx, ctx: TenantState, id: string, lock = false): Promise<RuleRow> {
    const q = tx
      .select()
      .from(priceRules)
      .where(and(eq(priceRules.tenantId, ctx.tenantId), eq(priceRules.id, id)));
    const [rule] = lock ? await q.for('update') : await q;
    if (!rule) throw Errors.notFound('Price rule');
    return rule;
  }

  /** Referenced IDs must belong to this tenant (conditions, tax rule). */
  private async checkReferences(
    tx: Tx,
    tenantId: string,
    conditions: RuleConditions,
    definition: RuleDefinition,
  ) {
    if (conditions.purityIds.length) {
      const n = await tx
        .select({ id: purityDefinitions.id })
        .from(purityDefinitions)
        .where(
          and(eq(purityDefinitions.tenantId, tenantId), inArray(purityDefinitions.id, conditions.purityIds)),
        );
      if (n.length !== new Set(conditions.purityIds).size)
        throw Errors.validation([{ path: 'conditions.purityIds', message: 'Unknown purity' }]);
    }
    if (conditions.categoryIds.length) {
      const n = await tx
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.tenantId, tenantId), inArray(categories.id, conditions.categoryIds)));
      if (n.length !== new Set(conditions.categoryIds).size)
        throw Errors.validation([{ path: 'conditions.categoryIds', message: 'Unknown category' }]);
    }
    if (definition.taxRuleId) {
      const [t] = await tx
        .select({ id: taxRules.id })
        .from(taxRules)
        .where(and(eq(taxRules.tenantId, tenantId), eq(taxRules.id, definition.taxRuleId)));
      if (!t) throw Errors.validation([{ path: 'definition.taxRuleId', message: 'Unknown tax rule' }]);
    }
  }

  async listRules(ctx: TenantState, bookId: string) {
    requirePricing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await this.loadBook(tx, ctx.tenantId, bookId);
      const rules = await tx
        .select()
        .from(priceRules)
        .where(and(eq(priceRules.tenantId, ctx.tenantId), eq(priceRules.bookId, bookId)))
        .orderBy(asc(priceRules.name));
      if (!rules.length) return { items: [] };
      const versions = await tx
        .select()
        .from(priceRuleVersions)
        .where(
          and(
            inArray(
              priceRuleVersions.ruleId,
              rules.map((r) => r.id),
            ),
            inArray(priceRuleVersions.status, ['draft', 'published']),
          ),
        );
      return {
        items: rules
          .map((r) => {
            const pub = versions.find((v) => v.ruleId === r.id && v.status === 'published');
            const draft = versions.find((v) => v.ruleId === r.id && v.status === 'draft');
            const shown = pub ?? draft;
            return {
              id: r.id,
              name: r.name,
              status:
                r.status === 'retired'
                  ? ('retired' as const)
                  : pub
                    ? ('published' as const)
                    : ('draft_only' as const),
              priority: shown?.priority ?? 0,
              publishedVersion: pub?.version ?? null,
              hasDraft: Boolean(draft),
              baseKind: shown ? RuleDefinition.parse(shown.definition).base.kind : ('metal' as const),
            };
          })
          .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name)),
      };
    });
  }

  async getRule(ctx: TenantState, id: string): Promise<PriceRule> {
    requirePricing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => this.ruleDetail(tx, await this.loadRule(tx, ctx, id)));
  }

  async createRule(auth: AuthState, ctx: TenantState, input: CreatePriceRuleRequest, meta: RequestMeta) {
    requirePricing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const book = await this.loadBook(tx, ctx.tenantId, input.bookId);
      if (book.status !== 'active')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', 'This price book is archived');
      await this.checkReferences(tx, ctx.tenantId, input.conditions, input.definition);
      const [rule] = await tx
        .insert(priceRules)
        .values({ tenantId: ctx.tenantId, bookId: book.id, name: input.name, createdBy: auth.userId })
        .returning();
      await tx.insert(priceRuleVersions).values({
        tenantId: ctx.tenantId,
        ruleId: rule!.id,
        version: 1,
        priority: input.priority,
        conditions: input.conditions,
        definition: input.definition,
        notes: input.notes ?? null,
        createdBy: auth.userId,
      });
      await audit(tx, auth, ctx, meta, 'pricing.rule_created', 'price_rule', rule!.id, {
        newValues: { name: input.name, bookId: book.id, priority: input.priority },
      });
      return this.ruleDetail(tx, rule!);
    });
  }

  async saveDraft(
    auth: AuthState,
    ctx: TenantState,
    ruleId: string,
    input: SaveRuleDraftRequest,
    meta: RequestMeta,
  ) {
    requirePricing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const rule = await this.loadRule(tx, ctx, ruleId, true);
      if (rule.status === 'retired')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', 'This rule is retired');
      await this.checkReferences(tx, ctx.tenantId, input.conditions, input.definition);
      const [draft] = await tx
        .select()
        .from(priceRuleVersions)
        .where(and(eq(priceRuleVersions.ruleId, rule.id), eq(priceRuleVersions.status, 'draft')))
        .for('update');
      const content = {
        priority: input.priority,
        conditions: input.conditions,
        definition: input.definition,
        notes: input.notes ?? null,
      };
      if (draft) {
        if (input.lockVersion !== draft.lockVersion) throw Errors.versionConflict(draft.lockVersion);
        await tx
          .update(priceRuleVersions)
          .set({ ...content, createdBy: auth.userId, lockVersion: draft.lockVersion + 1 })
          .where(eq(priceRuleVersions.id, draft.id));
      } else {
        if (input.lockVersion !== undefined) throw Errors.versionConflict();
        const [{ v }] = (await tx
          .select({ v: max(priceRuleVersions.version) })
          .from(priceRuleVersions)
          .where(eq(priceRuleVersions.ruleId, rule.id))) as [{ v: number | null }];
        await tx.insert(priceRuleVersions).values({
          tenantId: ctx.tenantId,
          ruleId: rule.id,
          version: (v ?? 0) + 1,
          ...content,
          createdBy: auth.userId,
        });
      }
      await audit(tx, auth, ctx, meta, 'pricing.rule_draft_saved', 'price_rule', rule.id, {
        newValues: content,
      });
      return this.ruleDetail(tx, rule);
    });
  }

  async publish(
    auth: AuthState,
    ctx: TenantState,
    ruleId: string,
    input: PublishRuleRequest,
    meta: RequestMeta,
  ) {
    requirePricing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const rule = await this.loadRule(tx, ctx, ruleId, true);
      if (rule.status === 'retired')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', 'This rule is retired');
      // Serialise publishing within a book so two concurrent publishes cannot both pass the conflict check.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`price-book:${rule.bookId}`}))`);
      const [draft] = await tx
        .select()
        .from(priceRuleVersions)
        .where(and(eq(priceRuleVersions.ruleId, rule.id), eq(priceRuleVersions.id, input.versionId)))
        .for('update');
      if (!draft) throw Errors.notFound('Rule version');
      if (draft.status !== 'draft')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', `Version ${draft.version} is ${draft.status}`);
      const settings = await loadPricingSettings(tx, ctx.tenantId);
      if (settings.ruleReviewRequired && draft.createdBy === auth.userId)
        throw new AppError(
          403,
          'SEPARATION_OF_DUTIES',
          'Rule review is required: someone other than the author must publish this version',
        );
      const conditions = RuleConditions.parse(draft.conditions);
      const definition = RuleDefinition.parse(draft.definition);
      await this.checkReferences(tx, ctx.tenantId, conditions, definition);
      // Conflict: another published rule in the same book with the same priority whose conditions overlap.
      const others = await tx
        .select({ v: priceRuleVersions, name: priceRules.name })
        .from(priceRuleVersions)
        .innerJoin(priceRules, eq(priceRules.id, priceRuleVersions.ruleId))
        .where(
          and(
            eq(priceRules.bookId, rule.bookId),
            eq(priceRules.status, 'active'),
            ne(priceRules.id, rule.id),
            eq(priceRuleVersions.status, 'published'),
            eq(priceRuleVersions.priority, draft.priority),
          ),
        );
      const clashes = others.filter((o) =>
        conditionsOverlap(conditions, RuleConditions.parse(o.v.conditions)),
      );
      if (clashes.length)
        throw new AppError(
          409,
          'RULE_CONFLICT',
          `Same priority and overlapping conditions as: ${clashes.map((c) => c.name).join(', ')}. Change the priority or narrow the conditions.`,
          {
            rules: clashes.map((c) => ({ id: c.v.ruleId, name: c.name })),
          },
        );
      const now = new Date();
      const [previous] = await tx
        .select()
        .from(priceRuleVersions)
        .where(and(eq(priceRuleVersions.ruleId, rule.id), eq(priceRuleVersions.status, 'published')))
        .for('update');
      if (previous)
        await tx
          .update(priceRuleVersions)
          .set({ status: 'superseded' })
          .where(eq(priceRuleVersions.id, previous.id));
      await tx
        .update(priceRuleVersions)
        .set({ status: 'published', publishedBy: auth.userId, publishedAt: now })
        .where(eq(priceRuleVersions.id, draft.id));
      await enqueueEvent(tx, {
        tenantId: ctx.tenantId,
        eventType: 'PriceRulePublished',
        aggregateType: 'price_rule',
        aggregateId: rule.id,
        aggregateVersion: draft.version,
        correlationId: meta.correlationId,
        payload: {
          ruleId: rule.id,
          versionId: draft.id,
          version: draft.version,
          bookId: rule.bookId,
          previousVersionId: previous?.id ?? null,
        },
      });
      await audit(tx, auth, ctx, meta, 'pricing.rule_published', 'price_rule', rule.id, {
        oldValues: previous ? { version: previous.version } : null,
        newValues: { version: draft.version, priority: draft.priority },
      });
      return this.ruleDetail(tx, rule);
    });
  }

  async retire(
    auth: AuthState,
    ctx: TenantState,
    ruleId: string,
    input: RetireRuleRequest,
    meta: RequestMeta,
  ) {
    requirePricing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const rule = await this.loadRule(tx, ctx, ruleId, true);
      if (rule.status === 'retired')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', 'This rule is already retired');
      const now = new Date();
      await tx
        .update(priceRuleVersions)
        .set({ status: 'retired' })
        .where(and(eq(priceRuleVersions.ruleId, rule.id), eq(priceRuleVersions.status, 'published')));
      const [after] = await tx
        .update(priceRules)
        .set({ status: 'retired', retiredAt: now, retireReason: input.reason })
        .where(eq(priceRules.id, rule.id))
        .returning();
      await audit(tx, auth, ctx, meta, 'pricing.rule_retired', 'price_rule', rule.id, {
        newValues: { status: 'retired' },
        reason: input.reason,
      });
      return this.ruleDetail(tx, after!);
    });
  }
}
