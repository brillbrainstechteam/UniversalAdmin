import { Injectable } from '@nestjs/common';
import {
  PricingError,
  RuleConditions,
  RuleDefinition,
  calculatePrice,
  currencyMinorUnits,
  planPromotions,
  ruleMatches,
  sumMinor,
  type CalculateRequest,
  type CalculateResponse,
  type CreateQuoteRequest,
  type ManualItem,
  type Page,
  type PriceBreakdown,
  type PriceQuote,
  type PriceQuoteListQuery,
  type PricingItem,
  type PricingItemResults,
  type PricingTax,
  type PromotionInput,
  type QuoteLine,
  type QuoteLineInput,
  type RevalidateQuoteResponse,
  type StorefrontQuote,
} from '@uc/contracts';
import {
  channelPublications,
  companies,
  channels,
  jewelleryComponents,
  jewellerySpecs,
  priceBooks,
  priceListEntries,
  priceQuotes,
  priceRules,
  priceRuleVersions,
  products,
  purityDefinitions,
  rateSources,
  serialItems,
  taxRules,
  users,
  variants,
  type Tx,
} from '@uc/db';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { decodeCursor, paginate } from '../../common/cursor';
import { AppError, Errors } from '../../common/errors';
import { iso, likePattern } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';
import {
  audit,
  currentRates,
  isSimulated,
  isStale,
  loadPricingSettings,
  requirePricing,
  type SettingsRow,
} from './pricing.common';

type BookRow = typeof priceBooks.$inferSelect;
type VersionRow = typeof priceRuleVersions.$inferSelect;
export type QuoteRow = typeof priceQuotes.$inferSelect;

interface ResolvedItem {
  item: PricingItem;
  variantId: string | null;
  serialItemId: string | null;
  sku: string | null;
  title: string;
  serialTag: string | null;
  purityLabel: string | null;
  /** Calculator only: list price typed in by the user. */
  listPrice?: string | null;
}

interface Candidate {
  book: BookRow;
  version: VersionRow;
  ruleName: string;
  conditions: RuleConditions;
  definition: RuleDefinition;
}

export interface Scope {
  tenantId: string;
  features: readonly string[];
  channelId: string | null;
  /** Storefront: only active products published to the channel with an active variant. */
  storefront: boolean;
  now: Date;
  settings: SettingsRow;
  /** Phase 08: the buying company's own price book (wins over channel and all-channel books). */
  companyBookId?: string | null;
}

const invalid = (message: string, details?: unknown) =>
  new AppError(422, 'PRICE_INPUT_INVALID', message, details);
function pricingFailure(e: unknown): never {
  if (e instanceof PricingError) {
    const status = e.code === 'RATE_STALE' ? 409 : 422;
    throw new AppError(status, e.code, e.message, e.details);
  }
  throw e;
}

/**
 * Server-side price calculation and immutable quotes (OD-4: lock at quote creation with TTL, revalidate at
 * checkout). Book precedence: channel-specific books before all-channel books, then priority (high first), then
 * name; within a book, published rules by priority (high first), then name; the first matching rule wins.
 */
@Injectable()
export class QuoteService {
  constructor(private readonly db: DbService) {}

  // ---------------------------------------------------------------- item resolution

  private async resolveItem(tx: Tx, scope: Scope, line: QuoteLineInput): Promise<ResolvedItem> {
    const [v] = await tx
      .select({ v: variants, p: products })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(and(eq(variants.tenantId, scope.tenantId), eq(variants.id, line.variantId)));
    if (!v) throw Errors.notFound('Variant');
    if (scope.storefront) {
      const [pub] = await tx
        .select({ id: channelPublications.productId })
        .from(channelPublications)
        .where(
          and(
            eq(channelPublications.productId, v.p.id),
            eq(channelPublications.channelId, scope.channelId!),
            eq(channelPublications.status, 'published'),
          ),
        );
      if (!pub || v.p.status !== 'active' || v.v.status !== 'active') throw Errors.notFound('Product');
    }
    const jewellery = scope.features.includes('jewellery') && v.p.productType === 'jewellery';
    const [spec] = jewellery
      ? await tx
          .select()
          .from(jewellerySpecs)
          .where(and(eq(jewellerySpecs.tenantId, scope.tenantId), eq(jewellerySpecs.variantId, v.v.id)))
      : [];
    const base = {
      productType: v.p.productType,
      categoryId: v.p.categoryId,
      quantity: line.quantity,
      billingBasis: spec?.billingBasis ?? null,
    } as const;
    let resolved: Omit<ResolvedItem, 'item'> & {
      item: Omit<PricingItem, keyof typeof base | 'stones'>;
      componentsOf: SQL | null;
    };

    if (line.serialItemId) {
      if (!jewellery) throw invalid('Only jewellery pieces are priced individually');
      const [piece] = await tx
        .select()
        .from(serialItems)
        .where(
          and(
            eq(serialItems.tenantId, scope.tenantId),
            eq(serialItems.id, line.serialItemId),
            eq(serialItems.variantId, v.v.id),
          ),
        );
      if (!piece) throw Errors.notFound('Serialized item');
      if (piece.status === 'pending_review')
        throw invalid(
          `Piece ${piece.serialTag} has a weight exception under review and cannot be priced yet`,
          { field: 'serialItemId' },
        );
      if (piece.status === 'retired' || piece.stockState === 'written_off')
        throw invalid(`Piece ${piece.serialTag} is no longer sellable`, { field: 'serialItemId' });
      if (scope.storefront && piece.stockState !== 'in_stock') throw Errors.notFound('Piece');
      resolved = {
        variantId: v.v.id,
        serialItemId: piece.id,
        sku: v.v.sku,
        title: `${v.p.title} — ${piece.serialTag}`,
        serialTag: piece.serialTag,
        purityLabel: null,
        item: {
          metal: piece.metal,
          purityId: piece.purityId,
          grossG: piece.grossG,
          netG: piece.netG,
          fineG: piece.fineG,
        },
        componentsOf: eq(jewelleryComponents.itemId, piece.id),
      };
    } else {
      resolved = {
        variantId: v.v.id,
        serialItemId: null,
        sku: v.v.sku,
        title: v.v.title ? `${v.p.title} — ${v.v.title}` : v.p.title,
        serialTag: null,
        purityLabel: null,
        item: spec
          ? {
              metal: spec.metal,
              purityId: spec.purityId,
              grossG: spec.grossG,
              netG: spec.netG,
              fineG: spec.fineG,
            }
          : { metal: null, purityId: null, grossG: null, netG: null, fineG: null },
        componentsOf: spec ? eq(jewelleryComponents.specId, spec.id) : null,
      };
    }
    const comps = resolved.componentsOf
      ? await tx
          .select()
          .from(jewelleryComponents)
          .where(and(eq(jewelleryComponents.tenantId, scope.tenantId), resolved.componentsOf))
          .orderBy(asc(jewelleryComponents.position))
      : [];
    if (resolved.item.purityId) {
      const [p] = await tx
        .select({ label: purityDefinitions.label })
        .from(purityDefinitions)
        .where(eq(purityDefinitions.id, resolved.item.purityId));
      resolved.purityLabel = p?.label ?? null;
    }
    const { componentsOf: _c, ...rest } = resolved;
    return {
      ...rest,
      item: {
        ...base,
        ...resolved.item,
        stones: comps
          .filter((c) => c.kind !== 'metal')
          .map((c) => ({
            kind: c.kind as 'diamond' | 'gemstone' | 'pearl' | 'other',
            grade: c.grade,
            count: c.count,
            weightG: c.weightG,
          })),
      },
    };
  }

  private manualItem(m: ManualItem): ResolvedItem {
    return {
      variantId: null,
      serialItemId: null,
      sku: null,
      title: 'Manual measurements',
      serialTag: null,
      purityLabel: null,
      item: {
        productType: m.productType,
        categoryId: m.categoryId,
        metal: null,
        purityId: m.purityId,
        grossG: m.grossG,
        netG: m.netG,
        fineG: m.fineG,
        billingBasis: m.billingBasis,
        stones: m.stones,
        quantity: m.quantity,
      },
    };
  }

  // ---------------------------------------------------------------- rule selection

  private async candidates(tx: Tx, scope: Scope): Promise<Candidate[]> {
    const books = await tx
      .select()
      .from(priceBooks)
      .where(
        and(
          eq(priceBooks.tenantId, scope.tenantId),
          eq(priceBooks.status, 'active'),
          or(
            scope.companyBookId ? eq(priceBooks.id, scope.companyBookId) : undefined,
            and(
              scope.channelId
                ? or(isNull(priceBooks.channelId), eq(priceBooks.channelId, scope.channelId))
                : isNull(priceBooks.channelId),
              // A book assigned to a company is that company's only: never used for anyone else.
              sql`not exists (select 1 from ${companies} c where c.tenant_id = ${scope.tenantId} and c.price_book_id = ${priceBooks.id})`,
            ),
          ),
          or(isNull(priceBooks.effectiveFrom), lte(priceBooks.effectiveFrom, scope.now)),
          or(isNull(priceBooks.effectiveTo), gt(priceBooks.effectiveTo, scope.now)),
        ),
      );
    if (!books.length) return [];
    const rows = await tx
      .select({ v: priceRuleVersions, name: priceRules.name, bookId: priceRules.bookId })
      .from(priceRuleVersions)
      .innerJoin(priceRules, eq(priceRules.id, priceRuleVersions.ruleId))
      .where(
        and(
          inArray(
            priceRules.bookId,
            books.map((b) => b.id),
          ),
          eq(priceRules.status, 'active'),
          eq(priceRuleVersions.status, 'published'),
        ),
      );
    const bookOrder = [...books].sort(
      (a, b) =>
        (b.id === scope.companyBookId ? 1 : 0) - (a.id === scope.companyBookId ? 1 : 0) ||
        (b.channelId ? 1 : 0) - (a.channelId ? 1 : 0) ||
        b.priority - a.priority ||
        a.name.localeCompare(b.name),
    );
    return bookOrder.flatMap((book) =>
      rows
        .filter((r) => r.bookId === book.id)
        .sort((a, b) => b.v.priority - a.v.priority || a.name.localeCompare(b.name))
        .map((r) => ({
          book,
          version: r.v,
          ruleName: r.name,
          conditions: RuleConditions.parse(r.v.conditions),
          definition: RuleDefinition.parse(r.v.definition),
        })),
    );
  }

  private async forcedCandidate(tx: Tx, tenantId: string, versionId: string): Promise<Candidate> {
    const [row] = await tx
      .select({ v: priceRuleVersions, name: priceRules.name, book: priceBooks })
      .from(priceRuleVersions)
      .innerJoin(priceRules, eq(priceRules.id, priceRuleVersions.ruleId))
      .innerJoin(priceBooks, eq(priceBooks.id, priceRules.bookId))
      .where(and(eq(priceRuleVersions.tenantId, tenantId), eq(priceRuleVersions.id, versionId)));
    if (!row) throw Errors.notFound('Rule version');
    return {
      book: row.book,
      version: row.v,
      ruleName: row.name,
      conditions: RuleConditions.parse(row.v.conditions),
      definition: RuleDefinition.parse(row.v.definition),
    };
  }

  // ---------------------------------------------------------------- pricing one line

  private async priceLine(
    tx: Tx,
    scope: Scope,
    resolved: ResolvedItem,
    candidates: Candidate[] | Candidate,
    promotions?: { id: string; label: string; discountMinor: string }[],
  ): Promise<QuoteLine> {
    const chosen = Array.isArray(candidates)
      ? candidates.find((c) => ruleMatches(c.conditions, resolved.item))
      : candidates;
    if (!chosen)
      throw new AppError(
        422,
        'PRICE_RULE_MISSING',
        `No published price rule applies to ${resolved.sku ?? resolved.title}`,
        {
          productType: resolved.item.productType,
          metal: resolved.item.metal,
        },
      );
    const def = chosen.definition;
    const needsRate = def.base.kind === 'metal' || def.wastage !== null;
    let rate: QuoteLine['rate'] = null;
    let engineRate = null;
    if (needsRate) {
      if (!scope.features.includes('metal_rates'))
        throw new AppError(422, 'RATE_MISSING', 'Metal rates are not enabled for this merchant');
      if (!resolved.item.purityId)
        throw invalid('The item has no purity, so no metal rate applies', { field: 'purityId' });
      const row = (
        await currentRates(tx, scope.tenantId, chosen.book.currency, [resolved.item.purityId], scope.now)
      ).get(resolved.item.purityId);
      if (!row)
        throw new AppError(
          422,
          'RATE_MISSING',
          `No approved ${chosen.book.currency} metal rate for ${resolved.purityLabel ?? 'this purity'}`,
        );
      const stale = isStale(row, scope.settings, scope.now);
      if (stale && scope.settings.stalePolicy === 'block')
        throw new AppError(
          409,
          'RATE_STALE',
          `The approved rate for ${resolved.purityLabel ?? 'this purity'} is older than the maximum rate age; approve a fresh rate`,
          {
            rateId: row.id,
            sourceAsOf: iso(row.sourceAsOf),
          },
        );
      const [source] = await tx.select().from(rateSources).where(eq(rateSources.id, row.sourceId));
      rate = {
        id: row.id,
        ratePerG: row.ratePerG,
        currency: row.currency,
        sourceAsOf: iso(row.sourceAsOf),
        stale,
        simulated: isSimulated(source!),
        sourceName: source!.name,
      };
      engineRate = { id: row.id, ratePerG: row.ratePerG, currency: row.currency, stale };
    }
    let listPrice: string | null = resolved.listPrice ?? null;
    if (def.base.kind === 'list_price' && resolved.variantId) {
      const [entry] = await tx
        .select()
        .from(priceListEntries)
        .where(
          and(
            eq(priceListEntries.bookId, chosen.book.id),
            eq(priceListEntries.variantId, resolved.variantId),
          ),
        );
      listPrice = entry?.amount ?? null;
    }
    let tax: PricingTax | null = null;
    if (def.taxRuleId) {
      const [t] = await tx
        .select()
        .from(taxRules)
        .where(and(eq(taxRules.tenantId, scope.tenantId), eq(taxRules.id, def.taxRuleId)));
      if (t)
        tax = {
          id: t.id,
          label: t.label,
          ratePercent: t.ratePercent,
          appliesTo: t.appliesTo as PricingTax['appliesTo'],
          status: t.status,
        };
    }
    let breakdown: PriceBreakdown;
    try {
      breakdown = calculatePrice(def, resolved.item, {
        currency: chosen.book.currency,
        rate: engineRate,
        listPrice,
        tax,
        ...(promotions?.length ? { promotions } : {}),
      });
    } catch (e) {
      pricingFailure(e);
    }
    if (rate?.simulated)
      breakdown.warnings.push('The metal rate comes from the rate simulator (test data, not a market rate)');
    return {
      variantId: resolved.variantId!,
      serialItemId: resolved.serialItemId,
      sku: resolved.sku!,
      title: resolved.title,
      serialTag: resolved.serialTag,
      quantity: resolved.item.quantity,
      measurements: {
        grossG: resolved.item.grossG,
        netG: resolved.item.netG,
        fineG: resolved.item.fineG,
        billingBasis: resolved.item.billingBasis,
        purity: resolved.purityLabel,
      },
      book: { id: chosen.book.id, name: chosen.book.name },
      rule: {
        id: chosen.version.ruleId,
        versionId: chosen.version.id,
        version: chosen.version.version,
        name: chosen.ruleName,
        status: chosen.version.status,
      },
      rate,
      breakdown,
    };
  }

  /** Pricing scope (tenant, features, channel, settings, "now"); public for order services. */
  async scope(
    tx: Tx,
    ctx: { tenantId: string; features: readonly string[] },
    channelId: string | null,
    storefront: boolean,
    companyBookId: string | null = null,
  ): Promise<Scope> {
    if (channelId && !storefront) {
      const [c] = await tx
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.tenantId, ctx.tenantId), eq(channels.id, channelId)));
      if (!c) throw Errors.validation([{ path: 'channelId', message: 'Unknown channel' }]);
    }
    return {
      tenantId: ctx.tenantId,
      features: ctx.features,
      channelId,
      storefront,
      now: new Date(),
      settings: await loadPricingSettings(tx, ctx.tenantId),
      companyBookId,
    };
  }

  // ---------------------------------------------------------------- item search

  async searchItems(ctx: TenantState, q: string): Promise<PricingItemResults> {
    requirePricing(ctx);
    const pattern = likePattern(q);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const vs = await tx
        .select({
          id: variants.id,
          sku: variants.sku,
          vTitle: variants.title,
          title: products.title,
          productType: products.productType,
        })
        .from(variants)
        .innerJoin(products, eq(products.id, variants.productId))
        .where(
          and(
            eq(variants.tenantId, ctx.tenantId),
            or(ilike(variants.sku, pattern), ilike(products.title, pattern)),
          ),
        )
        .orderBy(asc(variants.sku))
        .limit(15);
      const pieces = ctx.features.includes('serialized_items')
        ? await tx
            .select({
              id: serialItems.id,
              tag: serialItems.serialTag,
              variantId: variants.id,
              sku: variants.sku,
              title: products.title,
            })
            .from(serialItems)
            .innerJoin(variants, eq(variants.id, serialItems.variantId))
            .innerJoin(products, eq(products.id, variants.productId))
            .where(
              and(
                eq(serialItems.tenantId, ctx.tenantId),
                eq(serialItems.status, 'active'),
                ne(serialItems.stockState, 'written_off'),
                or(ilike(serialItems.serialTag, pattern), ilike(variants.sku, pattern)),
              ),
            )
            .orderBy(asc(serialItems.serialTag))
            .limit(15)
        : [];
      return {
        items: [
          ...vs.map((v) => ({
            variantId: v.id,
            sku: v.sku,
            title: v.vTitle ? `${v.title} — ${v.vTitle}` : v.title,
            productType: v.productType,
            serialItemId: null,
            serialTag: null,
          })),
          ...pieces.map((p) => ({
            variantId: p.variantId,
            sku: p.sku,
            title: p.title,
            productType: 'jewellery' as const,
            serialItemId: p.id,
            serialTag: p.tag,
          })),
        ],
      };
    });
  }

  // ---------------------------------------------------------------- calculator

  async calculate(ctx: TenantState, input: CalculateRequest): Promise<CalculateResponse> {
    requirePricing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const scope = await this.scope(tx, ctx, input.channelId, false);
      const forced = input.ruleVersionId
        ? await this.forcedCandidate(tx, ctx.tenantId, input.ruleVersionId)
        : null;
      let resolved: ResolvedItem;
      if (input.manual) {
        resolved = this.manualItem(input.manual);
        if (resolved.item.purityId) {
          const [p] = await tx
            .select()
            .from(purityDefinitions)
            .where(
              and(
                eq(purityDefinitions.tenantId, ctx.tenantId),
                eq(purityDefinitions.id, resolved.item.purityId),
              ),
            );
          if (!p) throw Errors.validation([{ path: 'manual.purityId', message: 'Unknown purity' }]);
          resolved.item.metal = p.metal;
          resolved.purityLabel = p.label;
        }
        resolved.listPrice = input.manual.listPrice;
      } else resolved = await this.resolveItem(tx, scope, input.line!);
      const line = await this.priceLine(tx, scope, resolved, forced ?? (await this.candidates(tx, scope)));
      return { line: { ...line, variantId: resolved.variantId, sku: resolved.sku }, persisted: false };
    });
  }

  // ---------------------------------------------------------------- quotes

  /** Prices every line (reads only). */
  /**
   * Prices lines. With `choosePromotions` (Phase 10 storefront orders), the order promotions it returns for the
   * line bases (after rule discounts) are split across lines exactly and each line is priced again with its share,
   * before tax.
   */
  async priceLines(
    tx: Tx,
    scope: Scope,
    lines: QuoteLineInput[],
    choosePromotions?: (lineBasesMinor: string[], currency: string) => Promise<PromotionInput[]>,
  ) {
    const candidates = await this.candidates(tx, scope);
    let priced: QuoteLine[] = [];
    const resolvedItems: ResolvedItem[] = [];
    for (const [i, l] of lines.entries()) {
      try {
        const resolved = await this.resolveItem(tx, scope, l);
        resolvedItems.push(resolved);
        priced.push(await this.priceLine(tx, scope, resolved, candidates));
      } catch (e) {
        if (e instanceof AppError && lines.length > 1)
          throw new AppError(e.status, e.code, `Line ${i + 1}: ${e.message}`, {
            line: i,
            ...(e.details as object),
          });
        throw e;
      }
    }
    const currencies = new Set(priced.map((p) => p.breakdown.currency));
    if (currencies.size > 1)
      throw invalid(
        `Lines are priced in different currencies (${[...currencies].join(', ')}); quote them separately`,
      );
    let promotionTotals: { id: string; discountMinor: string }[] = [];
    if (choosePromotions && priced.length) {
      const currency = priced[0]!.breakdown.currency;
      const bases = priced.map((p) =>
        (BigInt(p.breakdown.subtotalMinor) - BigInt(p.breakdown.discountMinor)).toString(),
      );
      const promos = await choosePromotions(bases, currency);
      if (promos.length) {
        const plan = planPromotions(bases, promos, currencyMinorUnits(currency));
        promotionTotals = plan.totals;
        priced = [];
        for (const [i, resolved] of resolvedItems.entries())
          priced.push(await this.priceLine(tx, scope, resolved, candidates, plan.perLine[i]));
      }
    }
    const pieces = new Set<string>();
    for (const p of priced)
      if (p.serialItemId) {
        if (pieces.has(p.serialItemId)) throw invalid(`Piece ${p.serialTag} appears twice`);
        pieces.add(p.serialItemId);
      }
    const total = (k: 'subtotalMinor' | 'discountMinor' | 'taxMinor' | 'totalMinor') =>
      BigInt(sumMinor(priced.map((p) => p.breakdown[k])));
    return {
      priced,
      currency: [...currencies][0]!,
      subtotalMinor: total('subtotalMinor'),
      discountMinor: total('discountMinor'),
      taxMinor: total('taxMinor'),
      totalMinor: total('totalMinor'),
      promotionTotals,
    };
  }

  async insertQuote(
    tx: Tx,
    scope: Scope,
    lines: QuoteLineInput[],
    p: Awaited<ReturnType<QuoteService['priceLines']>>,
    origin: 'admin' | 'storefront',
    createdBy: string | null,
    /** Quotations hold their price until a chosen date instead of the pricing TTL. */
    expiresAt?: Date,
  ): Promise<QuoteRow> {
    const [row] = await tx
      .insert(priceQuotes)
      .values({
        tenantId: scope.tenantId,
        channelId: scope.channelId,
        origin,
        currency: p.currency,
        lineInputs: lines,
        lines: p.priced,
        subtotalMinor: p.subtotalMinor,
        discountMinor: p.discountMinor,
        taxMinor: p.taxMinor,
        totalMinor: p.totalMinor,
        warnings: [...new Set(p.priced.flatMap((l) => l.breakdown.warnings))],
        createdBy,
        createdAt: scope.now,
        expiresAt: expiresAt ?? new Date(scope.now.getTime() + scope.settings.quoteTtlMinutes * 60_000),
      })
      .returning();
    return row!;
  }

  async toQuote(tx: Tx, row: QuoteRow): Promise<PriceQuote> {
    const [channel] = row.channelId
      ? await tx
          .select({ id: channels.id, name: channels.name })
          .from(channels)
          .where(eq(channels.id, row.channelId))
      : [];
    const [creator] = row.createdBy
      ? await tx
          .select({ id: users.id, name: users.displayName })
          .from(users)
          .where(eq(users.id, row.createdBy))
      : [];
    return {
      id: row.id,
      channel: channel ?? null,
      origin: row.origin,
      status: row.supersededBy ? 'superseded' : row.expiresAt.getTime() <= Date.now() ? 'expired' : 'active',
      currency: row.currency,
      lines: row.lines as QuoteLine[],
      subtotalMinor: row.subtotalMinor.toString(),
      discountMinor: row.discountMinor.toString(),
      taxMinor: row.taxMinor.toString(),
      totalMinor: row.totalMinor.toString(),
      warnings: row.warnings as string[],
      createdBy: creator ?? null,
      createdAt: iso(row.createdAt),
      expiresAt: iso(row.expiresAt),
      supersededBy: row.supersededBy,
    };
  }

  async create(
    auth: AuthState,
    ctx: TenantState,
    input: CreateQuoteRequest,
    meta: RequestMeta,
  ): Promise<PriceQuote> {
    requirePricing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const scope = await this.scope(tx, ctx, input.channelId, false);
      const row = await this.insertQuote(
        tx,
        scope,
        input.lines,
        await this.priceLines(tx, scope, input.lines),
        'admin',
        auth.userId,
      );
      await audit(tx, auth, ctx, meta, 'pricing.quote_created', 'price_quote', row.id, {
        newValues: {
          totalMinor: row.totalMinor.toString(),
          currency: row.currency,
          lines: input.lines.length,
          expiresAt: iso(row.expiresAt),
        },
      });
      return this.toQuote(tx, row);
    });
  }

  async get(ctx: TenantState, id: string): Promise<PriceQuote> {
    requirePricing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) =>
      this.toQuote(tx, await this.loadQuote(tx, ctx.tenantId, id)),
    );
  }

  private async loadQuote(tx: Tx, tenantId: string, id: string, lock = false): Promise<QuoteRow> {
    const q = tx
      .select()
      .from(priceQuotes)
      .where(and(eq(priceQuotes.tenantId, tenantId), eq(priceQuotes.id, id)));
    const [row] = lock ? await q.for('update') : await q;
    if (!row) throw Errors.notFound('Quote');
    return row;
  }

  async list(ctx: TenantState, q: PriceQuoteListQuery): Promise<Page<ReturnType<QuoteService['summary']>>> {
    requirePricing(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const now = new Date();
      const where: (SQL | undefined)[] = [eq(priceQuotes.tenantId, ctx.tenantId)];
      if (q.status === 'superseded') where.push(isNotNull(priceQuotes.supersededBy));
      if (q.status === 'active') where.push(isNull(priceQuotes.supersededBy), gt(priceQuotes.expiresAt, now));
      if (q.status === 'expired')
        where.push(isNull(priceQuotes.supersededBy), lte(priceQuotes.expiresAt, now));
      if (cursor) {
        const at = new Date(String(cursor.sortValue));
        where.push(
          or(
            lt(priceQuotes.createdAt, at),
            and(eq(priceQuotes.createdAt, at), lt(priceQuotes.id, cursor.id)),
          ),
        );
      }
      const rows = await tx
        .select({
          q: priceQuotes,
          channelName: channels.name,
          lineCount: sql<number>`jsonb_array_length(${priceQuotes.lines})::int`,
        })
        .from(priceQuotes)
        .leftJoin(channels, eq(channels.id, priceQuotes.channelId))
        .where(and(...where))
        .orderBy(desc(priceQuotes.createdAt), desc(priceQuotes.id))
        .limit(q.limit + 1);
      return paginate(
        rows.map((r) => this.summary(r.q, r.channelName, r.lineCount, now)),
        q.limit,
        (r) => r.createdAt,
      );
    });
  }

  private summary(r: QuoteRow, channelName: string | null, lineCount: number, now: Date) {
    return {
      id: r.id,
      channel: r.channelId ? { id: r.channelId, name: channelName ?? '' } : null,
      origin: r.origin,
      status: r.supersededBy
        ? ('superseded' as const)
        : r.expiresAt <= now
          ? ('expired' as const)
          : ('active' as const),
      currency: r.currency,
      lineCount,
      totalMinor: r.totalMinor.toString(),
      createdAt: iso(r.createdAt),
      expiresAt: iso(r.expiresAt),
    };
  }

  /**
   * Re-prices the quote's lines with current rates and rules. Unchanged and still valid → the same quote.
   * Otherwise a new quote supersedes it (the original stays exactly as shown). Failures → "unavailable".
   */
  async revalidate(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    meta: RequestMeta,
  ): Promise<RevalidateQuoteResponse> {
    requirePricing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const old = await this.loadQuote(tx, ctx.tenantId, id, true);
      if (old.supersededBy)
        throw new AppError(409, 'INVALID_STATE_TRANSITION', 'This quote was already replaced', {
          supersededBy: old.supersededBy,
        });
      const scope = await this.scope(tx, ctx, old.channelId, old.origin === 'storefront');
      const inputs = old.lineInputs as QuoteLineInput[];
      let priced: Awaited<ReturnType<QuoteService['priceLines']>>;
      try {
        // Savepoint: a failed re-price must not abort the outer transaction.
        priced = await tx.transaction((sp) => this.priceLines(sp, scope, inputs));
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        return {
          status: 'unavailable',
          quote: await this.toQuote(tx, old),
          previousTotalMinor: old.totalMinor.toString(),
          newTotalMinor: null,
          problems: [{ code: e.code, message: e.message }],
        };
      }
      const same = priced.totalMinor === old.totalMinor && priced.currency === old.currency;
      if (same && old.expiresAt.getTime() > Date.now()) {
        return {
          status: 'unchanged',
          quote: await this.toQuote(tx, old),
          previousTotalMinor: old.totalMinor.toString(),
          newTotalMinor: old.totalMinor.toString(),
          problems: [],
        };
      }
      const fresh = await this.insertQuote(tx, scope, inputs, priced, old.origin, auth.userId);
      await tx
        .update(priceQuotes)
        .set({ supersededBy: fresh.id, supersededAt: new Date() })
        .where(eq(priceQuotes.id, old.id));
      await audit(tx, auth, ctx, meta, 'pricing.quote_revalidated', 'price_quote', old.id, {
        oldValues: { totalMinor: old.totalMinor.toString() },
        newValues: { quoteId: fresh.id, totalMinor: fresh.totalMinor.toString(), changed: !same },
      });
      return {
        status: same ? 'unchanged' : 'changed',
        quote: await this.toQuote(tx, fresh),
        previousTotalMinor: old.totalMinor.toString(),
        newTotalMinor: fresh.totalMinor.toString(),
        problems: [],
      };
    });
  }

  // ---------------------------------------------------------------- storefront

  async storefrontQuote(
    tenant: { tenantId: string; channelId: string; features: readonly string[] },
    lines: QuoteLineInput[],
  ): Promise<StorefrontQuote> {
    if (!tenant.features.includes('pricing')) throw Errors.notFound('Pricing');
    return this.db.tenant(tenant.tenantId, async (tx) => {
      const scope = await this.scope(tx, tenant, tenant.channelId, true);
      const row = await this.insertQuote(
        tx,
        scope,
        lines,
        await this.priceLines(tx, scope, lines),
        'storefront',
        null,
      );
      return this.toStorefrontQuote(row);
    });
  }

  /** Customer-facing view of a quote: labels and amounts, rate time, expiry — no internal IDs. */
  toStorefrontQuote(row: QuoteRow): StorefrontQuote {
    const priced = row.lines as QuoteLine[];
    const notes = [
      `Prices are held until ${iso(row.expiresAt)}; after that they are recalculated at checkout.`,
    ];
    if (priced.some((p) => p.breakdown.tax?.status === 'pending_validation'))
      notes.push('Tax shown is an estimate pending validation.');
    if (priced.some((p) => p.rate?.simulated))
      notes.push('Metal values use simulated test rates (not market data).');
    return {
      id: row.id,
      currency: row.currency,
      expiresAt: iso(row.expiresAt),
      lines: priced.map((p) => ({
        variantId: p.variantId,
        serialItemId: p.serialItemId,
        title: p.title,
        quantity: p.quantity,
        components: p.breakdown.components.map((c) => ({ label: c.label, amountMinor: c.amountMinor })),
        discountMinor: p.breakdown.discountMinor,
        taxMinor: p.breakdown.taxMinor,
        totalMinor: p.breakdown.totalMinor,
        rateAsOf: p.rate?.sourceAsOf ?? null,
      })),
      totalMinor: row.totalMinor.toString(),
      notes,
    };
  }
}
