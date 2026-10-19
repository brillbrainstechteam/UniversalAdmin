import { CurrencyCode, PageQuery, Reason, Timestamp, Uuid, Version, pageOf } from '../common';
import { cmpDecimal } from '../pricing-engine';
import { z } from '../z';
import { ActorRef } from './inventory';
import { Metal } from './jewellery';

/**
 * Phase 06 pricing contracts (specs/04). Money amounts in rules and rates are decimal strings in MAJOR units
 * (e.g. "6250.50" INR per gram); computed results are integer MINOR units as strings ({amountMinor,currency}).
 */

/** Non-negative decimal in major currency units, up to 6 decimals. */
export const Amount = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,6})?$/, 'Use a number ≥ 0 with up to 6 decimals, e.g. 450.50')
  .openapi({ description: 'Non-negative decimal amount in major units (string)', example: '450.50' });
const percent = (max: number) =>
  z
    .string()
    .regex(/^\d{1,4}(\.\d{1,4})?$/, 'Use a percentage with up to 4 decimals, e.g. 2.5')
    .refine((v) => cmpDecimal(v, String(max)) <= 0, `Must be at most ${max}%`)
    .openapi({ description: `Percentage 0–${max} (string)`, example: '2.5' });
export const Percent100 = percent(100);
const GramsInput = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,6})?$/, 'Use grams with up to 6 decimals')
  .openapi({ description: 'Grams (decimal string)' });
const MinorAmount = z.string().regex(/^-?\d+$/).openapi({ description: 'Integer minor units (string)' });

// ---------------------------------------------------------------- rates

export const RATE_UNITS = ['per_g', 'per_10g', 'per_kg'] as const;
export const RateUnit = z.enum(RATE_UNITS);
export type RateUnit = z.infer<typeof RateUnit>;
export const RateStatus = z.enum(['proposed', 'approved', 'rejected']);

export const RateSourceRef = z
  .object({ id: Uuid, name: z.string(), kind: z.enum(['manual', 'provider']), providerKey: z.string().nullable(), simulated: z.boolean() })
  .openapi('RateSourceRef');

export const MetalRate = z
  .object({
    id: Uuid,
    source: RateSourceRef,
    metal: Metal,
    purity: z.object({ id: Uuid, code: z.string(), label: z.string() }),
    currency: CurrencyCode,
    /** Canonical rate per gram in major units, 6 dp. */
    ratePerG: z.string(),
    input: z.object({ value: z.string(), unit: RateUnit }),
    sourceAsOf: Timestamp,
    effectiveFrom: Timestamp,
    status: RateStatus,
    reason: z.string().nullable(),
    proposedBy: ActorRef,
    proposedAt: Timestamp,
    decidedBy: ActorRef,
    decidedAt: Timestamp.nullable(),
    decisionNote: z.string().nullable(),
    /** This is the rate quotes use now for its metal + purity + currency. */
    isCurrent: z.boolean(),
    /** Source time older than the tenant's maximum rate age. */
    stale: z.boolean(),
  })
  .openapi('MetalRate');
export type MetalRate = z.infer<typeof MetalRate>;
export const MetalRatePage = pageOf(MetalRate).openapi('MetalRatePage');

export const MetalRateListQuery = PageQuery.extend({
  status: RateStatus.optional(),
  purityId: Uuid.optional(),
});
export type MetalRateListQuery = z.infer<typeof MetalRateListQuery>;

export const ProposeRateRequest = z
  .object({
    /** Defaults to the tenant's manual source. */
    sourceId: Uuid.optional(),
    purityId: Uuid,
    currency: CurrencyCode.optional(),
    value: Amount.refine((v) => /[1-9]/.test(v), 'Rate must be greater than 0'),
    unit: RateUnit,
    /** When the quoted value was valid at the source (defaults to now). */
    sourceAsOf: z.string().datetime().optional(),
    /** When quotes may start using it after approval (defaults to approval time). */
    effectiveFrom: z.string().datetime().optional(),
    reason: Reason,
  })
  .openapi('ProposeRateRequest');
export type ProposeRateRequest = z.infer<typeof ProposeRateRequest>;

export const ApproveRateRequest = z
  .object({ note: z.string().trim().max(500).optional() })
  .openapi('ApproveRateRequest');
export type ApproveRateRequest = z.infer<typeof ApproveRateRequest>;
export const RejectRateRequest = z.object({ reason: Reason }).openapi('RejectRateRequest');
export type RejectRateRequest = z.infer<typeof RejectRateRequest>;

export const CurrentRate = z
  .object({
    metal: Metal,
    purity: z.object({ id: Uuid, code: z.string(), label: z.string() }),
    currency: CurrencyCode,
    rate: MetalRate.nullable(),
    pending: z.number().int(),
    stale: z.boolean(),
    ageMinutes: z.number().int().nullable(),
  })
  .openapi('CurrentRate');
export type CurrentRate = z.infer<typeof CurrentRate>;
export const CurrentRates = z
  .object({ items: z.array(CurrentRate), maxAgeMinutes: z.number().int(), stalePolicy: z.enum(['block', 'use_last_approved']) })
  .openapi('CurrentRates');
export type CurrentRates = z.infer<typeof CurrentRates>;

export const RateProvider = z
  .object({
    key: z.string(),
    label: z.string(),
    tier: z.enum(['available', 'blocked']),
    simulated: z.boolean(),
    description: z.string(),
    blockedBy: z.array(z.string()),
    units: z.array(RateUnit),
  })
  .openapi('RateProvider');
export type RateProvider = z.infer<typeof RateProvider>;

export const RateSource = z
  .object({
    id: Uuid,
    name: z.string(),
    kind: z.enum(['manual', 'provider']),
    providerKey: z.string().nullable(),
    simulated: z.boolean(),
    status: z.enum(['active', 'disabled']),
    credentialRef: z.string().nullable(),
    licenceRef: z.string().nullable(),
    lastPulledAt: Timestamp.nullable(),
    version: Version,
  })
  .openapi('RateSource');
export type RateSource = z.infer<typeof RateSource>;
export const RateSourceList = z
  .object({ items: z.array(RateSource), providers: z.array(RateProvider) })
  .openapi('RateSourceList');

export const CreateRateSourceRequest = z
  .object({
    providerKey: z.string().min(1).max(40),
    name: z.string().trim().min(1).max(80),
    /** Secret-store reference only (vault:/env:/secretsmanager:) — never a secret value. */
    credentialRef: z
      .string()
      .trim()
      .regex(/^(vault|env|secretsmanager):[A-Za-z0-9_./:-]{1,200}$/, 'Give a secret reference like vault:rates/key, not a secret')
      .nullable()
      .optional(),
    licenceRef: z.string().trim().max(200).nullable().optional(),
  })
  .openapi('CreateRateSourceRequest');
export type CreateRateSourceRequest = z.infer<typeof CreateRateSourceRequest>;

export const PullRatesRequest = z
  .object({
    /** Simulator only: pretend the source quoted this many minutes ago (to exercise staleness). */
    asOfMinutesAgo: z.number().int().min(0).max(100_000).default(0),
  })
  .openapi('PullRatesRequest');
export type PullRatesRequest = z.infer<typeof PullRatesRequest>;
export const PullRatesResponse = z
  .object({ proposed: z.array(MetalRate), skipped: z.array(z.object({ code: z.string(), message: z.string() })) })
  .openapi('PullRatesResponse');

// ---------------------------------------------------------------- settings & tax rules

export const StalePolicy = z.enum(['block', 'use_last_approved']);
export const PricingSettings = z
  .object({
    quoteTtlMinutes: z.number().int(),
    rateMaxAgeMinutes: z.number().int(),
    stalePolicy: StalePolicy,
    ruleReviewRequired: z.boolean(),
    version: Version,
    updatedAt: Timestamp,
  })
  .openapi('PricingSettings');
export type PricingSettings = z.infer<typeof PricingSettings>;
export const UpdatePricingSettingsRequest = z
  .object({
    version: Version,
    quoteTtlMinutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
    rateMaxAgeMinutes: z.number().int().min(1).max(31 * 24 * 60).optional(),
    stalePolicy: StalePolicy.optional(),
    ruleReviewRequired: z.boolean().optional(),
  })
  .openapi('UpdatePricingSettingsRequest');
export type UpdatePricingSettingsRequest = z.infer<typeof UpdatePricingSettingsRequest>;

/** Component groups a discount or tax rule can apply to. */
export const COMPONENT_GROUPS = ['metal', 'making', 'wastage', 'stones', 'charges', 'list_price'] as const;
export const ComponentGroup = z.enum(COMPONENT_GROUPS);
export type ComponentGroup = z.infer<typeof ComponentGroup>;

export const TaxRule = z
  .object({
    id: Uuid,
    label: z.string(),
    ratePercent: z.string(),
    appliesTo: z.array(ComponentGroup),
    status: z.enum(['pending_validation', 'validated', 'inactive']),
    validationNote: z.string().nullable(),
    version: Version,
    updatedAt: Timestamp,
  })
  .openapi('TaxRule');
export type TaxRule = z.infer<typeof TaxRule>;
export const TaxRuleList = z.object({ items: z.array(TaxRule) }).openapi('TaxRuleList');
export const CreateTaxRuleRequest = z
  .object({
    label: z.string().trim().min(1).max(80),
    ratePercent: Percent100,
    appliesTo: z.array(ComponentGroup).min(1),
  })
  .openapi('CreateTaxRuleRequest');
export type CreateTaxRuleRequest = z.infer<typeof CreateTaxRuleRequest>;
export const UpdateTaxRuleRequest = z
  .object({
    version: Version,
    label: z.string().trim().min(1).max(80).optional(),
    ratePercent: Percent100.optional(),
    appliesTo: z.array(ComponentGroup).min(1).optional(),
    status: z.enum(['pending_validation', 'validated', 'inactive']).optional(),
    /** Who validated it and against what (required when marking validated). */
    validationNote: z.string().trim().max(500).nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.status === 'validated' && !(v.validationNote && v.validationNote.length >= 5))
      ctx.addIssue({ code: 'custom', path: ['validationNote'], message: 'Record who validated this rule and how' });
  })
  .openapi('UpdateTaxRuleRequest');
export type UpdateTaxRuleRequest = z.infer<typeof UpdateTaxRuleRequest>;

// ---------------------------------------------------------------- rule DSL (data, never executed)

export const WeightBasis = z.enum(['gross', 'net', 'fine', 'item']);
export type WeightBasis = z.infer<typeof WeightBasis>;

export const Making = z
  .discriminatedUnion('mode', [
    z.object({ mode: z.literal('none') }),
    z.object({ mode: z.literal('per_gram'), amount: Amount, weightBasis: WeightBasis.optional() }),
    z.object({ mode: z.literal('per_piece'), amount: Amount }),
    z.object({ mode: z.literal('percent_of_metal'), percent: percent(1000) }),
    z.object({ mode: z.literal('per_line'), amount: Amount }),
    z.object({
      mode: z.literal('tiered_per_gram'),
      weightBasis: WeightBasis.optional(),
      /** Ascending tiers on billable grams per piece; the last tier has upToG = null. */
      tiers: z
        .array(z.object({ upToG: GramsInput.nullable(), amount: Amount }))
        .min(1)
        .max(10)
        .superRefine((tiers, ctx) => {
          tiers.forEach((t, i) => {
            const last = i === tiers.length - 1;
            if (last !== (t.upToG === null))
              ctx.addIssue({ code: 'custom', path: [i, 'upToG'], message: last ? 'The last tier has no upper limit' : 'Only the last tier may be open-ended' });
            const prev = tiers[i - 1]?.upToG;
            if (i > 0 && t.upToG !== null && prev && cmpDecimal(t.upToG, prev) <= 0)
              ctx.addIssue({ code: 'custom', path: [i, 'upToG'], message: 'Tiers must increase' });
          });
        }),
    }),
  ])
  .openapi('MakingCharge');
export type Making = z.infer<typeof Making>;

export const StoneRate = z.object({
  kind: z.enum(['diamond', 'gemstone', 'pearl', 'other']),
  /** Exact grade match (case-insensitive); null = any grade of this kind. */
  grade: z.string().trim().min(1).max(60).nullable().default(null),
  amount: Amount,
});
export const ChargeCode = z.enum(['hallmark', 'certificate', 'packing', 'labour', 'other']);
export const Charge = z.object({
  code: ChargeCode,
  label: z.string().trim().min(1).max(60),
  mode: z.enum(['per_piece', 'per_gram', 'per_line']),
  amount: Amount,
});

export const RuleDefinition = z
  .object({
    base: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('metal'), weightBasis: WeightBasis }),
      z.object({ kind: z.literal('list_price') }),
    ]),
    making: Making.default({ mode: 'none' }),
    /** Added weight as a % of billable weight, valued at the metal rate (explicit basis, never implied). */
    wastage: z.object({ percent: Percent100, weightBasis: WeightBasis.optional() }).nullable().default(null),
    stones: z
      .object({ mode: z.enum(['per_carat', 'per_piece']), rates: z.array(StoneRate).min(1).max(50) })
      .nullable()
      .default(null),
    charges: z.array(Charge).max(10).default([]),
    discount: z
      .object({ mode: z.enum(['percent', 'fixed']), value: Amount, appliesTo: z.array(ComponentGroup).min(1) })
      .refine((d) => d.mode !== 'percent' || cmpDecimal(d.value, '100') <= 0, { message: 'A percentage discount is at most 100', path: ['value'] })
      .nullable()
      .default(null),
    taxRuleId: Uuid.nullable().default(null),
  })
  .superRefine((d, ctx) => {
    if (d.base.kind === 'list_price' && (d.making.mode === 'percent_of_metal' || d.wastage))
      ctx.addIssue({ code: 'custom', path: ['base'], message: 'Making as % of metal and wastage need a metal-value base' });
  })
  .openapi('PriceRuleDefinition');
export type RuleDefinition = z.infer<typeof RuleDefinition>;
export type RuleDefinitionInput = z.input<typeof RuleDefinition>;

export const RuleConditions = z
  .object({
    productTypes: z.array(z.enum(['standard', 'jewellery'])).max(2).default([]),
    categoryIds: z.array(Uuid).max(50).default([]),
    metals: z.array(Metal).max(5).default([]),
    purityIds: z.array(Uuid).max(50).default([]),
  })
  .openapi('PriceRuleConditions');
export type RuleConditions = z.infer<typeof RuleConditions>;

// ---------------------------------------------------------------- books & rules

export const PriceBook = z
  .object({
    id: Uuid,
    name: z.string(),
    channel: z.object({ id: Uuid, name: z.string() }).nullable(),
    priority: z.number().int(),
    currency: CurrencyCode,
    status: z.enum(['active', 'archived']),
    effectiveFrom: Timestamp.nullable(),
    effectiveTo: Timestamp.nullable(),
    ruleCount: z.number().int(),
    listPriceCount: z.number().int(),
    version: Version,
    updatedAt: Timestamp,
  })
  .openapi('PriceBook');
export type PriceBook = z.infer<typeof PriceBook>;
export const PriceBookList = z.object({ items: z.array(PriceBook) }).openapi('PriceBookList');

const BookFields = {
  name: z.string().trim().min(1).max(80),
  channelId: Uuid.nullable(),
  priority: z.number().int().min(0).max(1000),
  effectiveFrom: z.string().datetime().nullable(),
  effectiveTo: z.string().datetime().nullable(),
};
export const CreatePriceBookRequest = z
  .object({ ...BookFields, currency: CurrencyCode.optional() })
  .partial({ channelId: true, priority: true, effectiveFrom: true, effectiveTo: true })
  .openapi('CreatePriceBookRequest');
export type CreatePriceBookRequest = z.infer<typeof CreatePriceBookRequest>;
export const UpdatePriceBookRequest = z
  .object({ version: Version, ...BookFields, status: z.enum(['active', 'archived']) })
  .partial()
  .required({ version: true })
  .openapi('UpdatePriceBookRequest');
export type UpdatePriceBookRequest = z.infer<typeof UpdatePriceBookRequest>;

export const ListPrice = z
  .object({ variantId: Uuid, sku: z.string(), productTitle: z.string(), amount: z.string(), updatedAt: Timestamp })
  .openapi('ListPrice');
export const ListPriceList = z.object({ items: z.array(ListPrice) }).openapi('ListPriceList');
export const PutListPricesRequest = z
  .object({
    items: z
      .array(z.object({ variantId: Uuid, amount: Amount.nullable() }))
      .min(1)
      .max(500),
  })
  .openapi('PutListPricesRequest');
export type PutListPricesRequest = z.infer<typeof PutListPricesRequest>;

export const RuleVersionStatus = z.enum(['draft', 'published', 'superseded', 'retired']);
export const PriceRuleVersion = z
  .object({
    id: Uuid,
    version: z.number().int(),
    status: RuleVersionStatus,
    priority: z.number().int(),
    conditions: RuleConditions,
    definition: RuleDefinition,
    notes: z.string().nullable(),
    createdBy: ActorRef,
    createdAt: Timestamp,
    publishedBy: ActorRef,
    publishedAt: Timestamp.nullable(),
    lockVersion: Version,
  })
  .openapi('PriceRuleVersion');
export type PriceRuleVersion = z.infer<typeof PriceRuleVersion>;
export const PriceRule = z
  .object({
    id: Uuid,
    bookId: Uuid,
    name: z.string(),
    status: z.enum(['draft_only', 'published', 'retired']),
    published: PriceRuleVersion.nullable(),
    draft: PriceRuleVersion.nullable(),
    versions: z.array(PriceRuleVersion),
  })
  .openapi('PriceRule');
export type PriceRule = z.infer<typeof PriceRule>;
export const PriceRuleSummary = z
  .object({
    id: Uuid,
    name: z.string(),
    status: z.enum(['draft_only', 'published', 'retired']),
    priority: z.number().int(),
    publishedVersion: z.number().int().nullable(),
    hasDraft: z.boolean(),
    baseKind: z.enum(['metal', 'list_price']),
  })
  .openapi('PriceRuleSummary');
export const PriceRuleList = z.object({ items: z.array(PriceRuleSummary) }).openapi('PriceRuleList');

const RuleDraftFields = {
  priority: z.number().int().min(0).max(1000),
  conditions: RuleConditions,
  definition: RuleDefinition,
  notes: z.string().trim().max(500).nullable().optional(),
};
export const CreatePriceRuleRequest = z
  .object({ bookId: Uuid, name: z.string().trim().min(1).max(80), ...RuleDraftFields })
  .openapi('CreatePriceRuleRequest');
export type CreatePriceRuleRequest = z.infer<typeof CreatePriceRuleRequest>;
export const SaveRuleDraftRequest = z
  .object({
    /** lockVersion of the current draft; omit when starting a new draft from the published version. */
    lockVersion: Version.optional(),
    ...RuleDraftFields,
  })
  .openapi('SaveRuleDraftRequest');
export type SaveRuleDraftRequest = z.infer<typeof SaveRuleDraftRequest>;
export const PublishRuleRequest = z.object({ versionId: Uuid }).openapi('PublishRuleRequest');
export type PublishRuleRequest = z.infer<typeof PublishRuleRequest>;
export const RetireRuleRequest = z.object({ reason: Reason }).openapi('RetireRuleRequest');
export type RetireRuleRequest = z.infer<typeof RetireRuleRequest>;

// ---------------------------------------------------------------- engine output

export const PriceComponent = z
  .object({
    code: z.string(),
    group: ComponentGroup,
    label: z.string(),
    /** Human-readable formula with exact operands. */
    formula: z.string(),
    inputs: z.record(z.string()),
    /** Exact value before rounding (major units). */
    exact: z.string(),
    amountMinor: MinorAmount,
    discountMinor: MinorAmount,
    taxableMinor: MinorAmount,
  })
  .openapi('PriceComponent');
export type PriceComponent = z.infer<typeof PriceComponent>;

export const PriceBreakdown = z
  .object({
    currency: CurrencyCode,
    minorUnits: z.number().int(),
    rounding: z.literal('component_half_up'),
    components: z.array(PriceComponent),
    subtotalMinor: MinorAmount,
    discountMinor: MinorAmount,
    tax: z
      .object({ ruleId: Uuid, label: z.string(), ratePercent: z.string(), status: z.string(), baseMinor: MinorAmount, exact: z.string() })
      .nullable(),
    taxMinor: MinorAmount,
    totalMinor: MinorAmount,
    warnings: z.array(z.string()),
  })
  .openapi('PriceBreakdown');
export type PriceBreakdown = z.infer<typeof PriceBreakdown>;

// ---------------------------------------------------------------- quotes & calculator

export const QuoteLineInput = z
  .object({
    variantId: Uuid,
    /** A specific physical piece (priced on its actual weights). */
    serialItemId: Uuid.optional(),
    quantity: z.number().int().min(1).max(10_000).default(1),
  })
  .superRefine((l, ctx) => {
    if (l.serialItemId && l.quantity !== 1) ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'A serialized piece is quoted with quantity 1' });
  })
  .openapi('QuoteLineInput');
export type QuoteLineInput = z.infer<typeof QuoteLineInput>;

export const QuoteLine = z
  .object({
    variantId: Uuid,
    serialItemId: Uuid.nullable(),
    sku: z.string(),
    title: z.string(),
    serialTag: z.string().nullable(),
    quantity: z.number().int(),
    measurements: z.object({
      grossG: z.string().nullable(),
      netG: z.string().nullable(),
      fineG: z.string().nullable(),
      billingBasis: z.string().nullable(),
      purity: z.string().nullable(),
    }),
    book: z.object({ id: Uuid, name: z.string() }),
    rule: z.object({ id: Uuid, versionId: Uuid, version: z.number().int(), name: z.string(), status: RuleVersionStatus }),
    rate: z
      .object({ id: Uuid, ratePerG: z.string(), currency: CurrencyCode, sourceAsOf: Timestamp, stale: z.boolean(), simulated: z.boolean(), sourceName: z.string() })
      .nullable(),
    breakdown: PriceBreakdown,
  })
  .openapi('QuoteLine');
export type QuoteLine = z.infer<typeof QuoteLine>;

export const QuoteStatus = z.enum(['active', 'expired', 'superseded']);
export const PriceQuote = z
  .object({
    id: Uuid,
    channel: z.object({ id: Uuid, name: z.string() }).nullable(),
    origin: z.enum(['admin', 'storefront']),
    status: QuoteStatus,
    currency: CurrencyCode,
    lines: z.array(QuoteLine),
    subtotalMinor: MinorAmount,
    discountMinor: MinorAmount,
    taxMinor: MinorAmount,
    totalMinor: MinorAmount,
    warnings: z.array(z.string()),
    createdBy: ActorRef,
    createdAt: Timestamp,
    expiresAt: Timestamp,
    supersededBy: Uuid.nullable(),
  })
  .openapi('PriceQuote');
export type PriceQuote = z.infer<typeof PriceQuote>;
export const PriceQuoteSummary = z
  .object({
    id: Uuid,
    channel: z.object({ id: Uuid, name: z.string() }).nullable(),
    origin: z.enum(['admin', 'storefront']),
    status: QuoteStatus,
    currency: CurrencyCode,
    lineCount: z.number().int(),
    totalMinor: MinorAmount,
    createdAt: Timestamp,
    expiresAt: Timestamp,
  })
  .openapi('PriceQuoteSummary');
export const PriceQuotePage = pageOf(PriceQuoteSummary).openapi('PriceQuotePage');
export const PriceQuoteListQuery = PageQuery.extend({ status: QuoteStatus.optional() });
export type PriceQuoteListQuery = z.infer<typeof PriceQuoteListQuery>;

export const CreateQuoteRequest = z
  .object({ channelId: Uuid.nullable().default(null), lines: z.array(QuoteLineInput).min(1).max(50) })
  .openapi('CreateQuoteRequest');
export type CreateQuoteRequest = z.infer<typeof CreateQuoteRequest>;

export const RevalidateQuoteResponse = z
  .object({
    status: z.enum(['unchanged', 'changed', 'unavailable']),
    quote: PriceQuote,
    previousTotalMinor: MinorAmount,
    newTotalMinor: MinorAmount.nullable(),
    problems: z.array(z.object({ code: z.string(), message: z.string() })),
  })
  .openapi('RevalidateQuoteResponse');
export type RevalidateQuoteResponse = z.infer<typeof RevalidateQuoteResponse>;

/** Ad-hoc measurements for the calculator (nothing is stored). */
export const ManualItem = z
  .object({
    productType: z.enum(['standard', 'jewellery']).default('jewellery'),
    purityId: Uuid.nullable().default(null),
    categoryId: Uuid.nullable().default(null),
    grossG: GramsInput.nullable().default(null),
    netG: GramsInput.nullable().default(null),
    fineG: GramsInput.nullable().default(null),
    billingBasis: z.enum(['gross', 'net', 'fine', 'piece']).nullable().default(null),
    stones: z
      .array(
        z.object({
          kind: z.enum(['diamond', 'gemstone', 'pearl', 'other']),
          grade: z.string().trim().max(60).nullable().default(null),
          count: z.number().int().min(1).max(10_000),
          weightG: GramsInput,
        }),
      )
      .max(50)
      .default([]),
    listPrice: Amount.nullable().default(null),
    quantity: z.number().int().min(1).max(10_000).default(1),
  })
  .openapi('ManualPricingItem');
export type ManualItem = z.infer<typeof ManualItem>;

export const CalculateRequest = z
  .object({
    channelId: Uuid.nullable().default(null),
    /** Price with this exact rule version (e.g. a draft under test) instead of book precedence. */
    ruleVersionId: Uuid.optional(),
    line: QuoteLineInput.optional(),
    manual: ManualItem.optional(),
  })
  .refine((r) => Boolean(r.line) !== Boolean(r.manual), 'Give either an item (line) or manual measurements')
  .refine((r) => !r.manual || r.ruleVersionId, { message: 'Manual measurements need a rule version to test', path: ['ruleVersionId'] })
  .openapi('CalculateRequest');
export type CalculateRequest = z.infer<typeof CalculateRequest>;
export const CalculateResponse = z
  .object({
    line: QuoteLine.omit({ variantId: true, sku: true, title: true }).extend({
      variantId: Uuid.nullable(),
      sku: z.string().nullable(),
      title: z.string(),
    }),
    persisted: z.literal(false),
  })
  .openapi('CalculateResponse');
export type CalculateResponse = z.infer<typeof CalculateResponse>;

// ---------------------------------------------------------------- storefront

export const StorefrontQuoteRequest = z
  .object({ lines: z.array(QuoteLineInput).min(1).max(20) })
  .openapi('StorefrontQuoteRequest');
export type StorefrontQuoteRequest = z.infer<typeof StorefrontQuoteRequest>;
export const StorefrontQuote = z
  .object({
    id: Uuid,
    currency: CurrencyCode,
    expiresAt: Timestamp,
    lines: z.array(
      z.object({
        variantId: Uuid,
        serialItemId: Uuid.nullable(),
        title: z.string(),
        quantity: z.number().int(),
        components: z.array(z.object({ label: z.string(), amountMinor: MinorAmount })),
        discountMinor: MinorAmount,
        taxMinor: MinorAmount,
        totalMinor: MinorAmount,
        rateAsOf: Timestamp.nullable(),
      }),
    ),
    totalMinor: MinorAmount,
    notes: z.array(z.string()),
  })
  .openapi('StorefrontQuote');
export type StorefrontQuote = z.infer<typeof StorefrontQuote>;

export const PricingCatalogOptions = z
  .object({
    purities: z.array(z.object({ id: Uuid, metal: Metal, code: z.string(), label: z.string() })),
    channels: z.array(z.object({ id: Uuid, name: z.string() })),
    taxRules: z.array(z.object({ id: Uuid, label: z.string(), status: z.string() })),
    currency: CurrencyCode,
  })
  .openapi('PricingOptions');
export type PricingCatalogOptions = z.infer<typeof PricingCatalogOptions>;

export const PricingItemQuery = z.object({ q: z.string().trim().min(1).max(100) });
export type PricingItemQuery = z.infer<typeof PricingItemQuery>;
export const PricingItemResults = z
  .object({
    items: z.array(
      z.object({
        variantId: Uuid,
        sku: z.string(),
        title: z.string(),
        productType: z.enum(['standard', 'jewellery']),
        serialItemId: Uuid.nullable(),
        serialTag: z.string().nullable(),
      }),
    ),
  })
  .openapi('PricingItemResults');
export type PricingItemResults = z.infer<typeof PricingItemResults>;
