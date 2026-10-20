import { CurrencyCode, PageQuery, Timestamp, Uuid, Version, pageOf } from '../common';
import { z } from '../z';
import { ThemeTokens } from './admin';

/**
 * Phase 10 online store content, domains, discounts, segments, campaigns and reports (ADR-025). Content is edited
 * as drafts and served only once published; discounts are evaluated by the server on every quote; campaigns
 * prepare consented audiences but nothing is sent until a notification connector exists; every report states its
 * metric formulas and when it was generated.
 */
const MinorAmount = z.string().regex(/^\d{1,18}$/, 'Whole minor units').openapi({ description: 'Integer minor units (string)' });
const Decimal = z.string().trim().regex(/^\d{1,12}(\.\d{1,6})?$/, 'A decimal number');

/** Internal storefront path ("/pages/about") or an https URL. Never javascript:, protocol-relative, or http. */
export const Href = z
  .string()
  .trim()
  .max(500)
  .refine((v) => (v.startsWith('/') && !v.startsWith('//')) || /^https:\/\/[^\s]+$/.test(v), 'Use a path starting with / or an https:// link');
export const PagePath = z.string().trim().max(300).regex(/^\/[^\s?#]*$/, 'A path starting with /, without query');
export const PageSlug = z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Lower-case letters, digits and hyphens').max(80);

// ---------------------------------------------------------------- site content

export const ContentBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), text: z.string().trim().min(1).max(200), level: z.union([z.literal(2), z.literal(3)]).default(2) }),
  z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(5000) }),
  z.object({ type: z.literal('image'), url: Href, alt: z.string().trim().max(200) }),
  z.object({ type: z.literal('products'), title: z.string().trim().max(120).nullable().default(null), collectionSlug: PageSlug }),
  z.object({ type: z.literal('cta'), label: z.string().trim().min(1).max(60), href: Href }),
]);
export type ContentBlock = z.infer<typeof ContentBlock>;
export const PageContent = z
  .object({
    title: z.string().trim().min(1).max(120),
    seoTitle: z.string().trim().max(70).nullable().default(null),
    seoDescription: z.string().trim().max(160).nullable().default(null),
    blocks: z.array(ContentBlock).max(40),
  })
  .openapi('PageContent');
export type PageContent = z.infer<typeof PageContent>;
export const MenuContent = z
  .object({ items: z.array(z.object({ label: z.string().trim().min(1).max(40), href: Href })).max(12) })
  .openapi('MenuContent');
export type MenuContent = z.infer<typeof MenuContent>;
export const BannerContent = z
  .object({
    message: z.string().trim().min(1).max(200),
    linkHref: Href.nullable().default(null),
    startsAt: z.string().datetime().nullable().default(null),
    endsAt: z.string().datetime().nullable().default(null),
  })
  .refine((b) => !b.startsAt || !b.endsAt || b.startsAt < b.endsAt, { message: 'The banner must end after it starts', path: ['endsAt'] })
  .openapi('BannerContent');
export type BannerContent = z.infer<typeof BannerContent>;

export const SiteDocumentKind = z.enum(['theme', 'menu', 'page', 'banner']);
export type SiteDocumentKind = z.infer<typeof SiteDocumentKind>;
export const MENU_KEYS = ['header', 'footer'] as const;
/** Validates content for a document kind. */
export function contentSchemaFor(kind: SiteDocumentKind) {
  return kind === 'theme' ? ThemeTokens : kind === 'menu' ? MenuContent : kind === 'page' ? PageContent : BannerContent;
}

export const SiteDocument = z
  .object({
    id: Uuid,
    channelId: Uuid,
    kind: SiteDocumentKind,
    key: z.string(),
    draft: z.record(z.unknown()),
    published: z.record(z.unknown()).nullable(),
    publishedVersion: z.number().int().nullable(),
    publishedAt: Timestamp.nullable(),
    live: z.boolean(),
    /** Draft differs from what is published. */
    hasChanges: z.boolean(),
    draftUpdatedAt: Timestamp,
    draftUpdatedBy: z.object({ id: Uuid, name: z.string() }).nullable(),
    versions: z.array(z.object({ version: z.number().int(), publishedAt: Timestamp, publishedBy: z.string().nullable(), note: z.string().nullable() })),
    version: Version,
  })
  .openapi('SiteDocument');
export type SiteDocument = z.infer<typeof SiteDocument>;
export const SiteDocumentList = z
  .object({ items: z.array(SiteDocument.omit({ draft: true, published: true, versions: true }).extend({ title: z.string() })) })
  .openapi('SiteDocumentList');
export const SiteQuery = z.object({ channelId: Uuid });
export type SiteQuery = z.infer<typeof SiteQuery>;
export const CreatePageRequest = z.object({ channelId: Uuid, slug: PageSlug, content: PageContent }).openapi('CreatePageRequest');
export type CreatePageRequest = z.infer<typeof CreatePageRequest>;
export const SaveDraftRequest = z.object({ version: Version, content: z.record(z.unknown()) }).openapi('SaveDraftRequest');
export type SaveDraftRequest = z.infer<typeof SaveDraftRequest>;
export const PublishRequest = z
  .object({ version: Version, note: z.string().trim().max(200).nullable().default(null), fromVersion: z.number().int().min(1).nullable().default(null) })
  .openapi('PublishRequest');
export type PublishRequest = z.infer<typeof PublishRequest>;
export const DocumentActionRequest = z.object({ version: Version }).openapi('DocumentActionRequest');
export type DocumentActionRequest = z.infer<typeof DocumentActionRequest>;
export const PreviewTokenRequest = z.object({ channelId: Uuid }).openapi('PreviewTokenRequest');
export const PreviewToken = z.object({ token: z.string(), expiresAt: Timestamp, hostname: z.string().nullable() }).openapi('PreviewToken');
export type PreviewToken = z.infer<typeof PreviewToken>;
export type PreviewTokenRequest = z.infer<typeof PreviewTokenRequest>;

/** What a storefront renders: published (or, with a valid preview token, draft) theme, menus and banner. */
export const StorefrontSite = z
  .object({
    preview: z.boolean(),
    theme: ThemeTokens,
    menus: z.object({ header: MenuContent, footer: MenuContent }),
    banner: BannerContent.nullable(),
    pages: z.array(z.object({ slug: z.string(), title: z.string() })),
  })
  .openapi('StorefrontSite');
export type StorefrontSite = z.infer<typeof StorefrontSite>;
export const StorefrontPage = PageContent.extend({ slug: z.string(), preview: z.boolean() }).openapi('StorefrontPage');
export type StorefrontPage = z.infer<typeof StorefrontPage>;

// ---------------------------------------------------------------- redirects & domains

export const Redirect = z
  .object({ id: Uuid, channelId: Uuid, fromPath: z.string(), toPath: z.string(), statusCode: z.union([z.literal(301), z.literal(302)]), createdAt: Timestamp })
  .openapi('Redirect');
export type Redirect = z.infer<typeof Redirect>;
export const CreateRedirectRequest = z
  .object({ channelId: Uuid, fromPath: PagePath, toPath: Href, statusCode: z.union([z.literal(301), z.literal(302)]).default(301) })
  .refine((r) => r.fromPath !== r.toPath, { message: 'A redirect cannot point to itself', path: ['toPath'] })
  .openapi('CreateRedirectRequest');
export type CreateRedirectRequest = z.infer<typeof CreateRedirectRequest>;
export const RedirectLookup = z.object({ toPath: z.string(), statusCode: z.number().int() }).openapi('RedirectLookup');
export const RedirectQuery = z.object({ path: PagePath });

export const Hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/, 'A domain such as shop.example.com');
export const StoreDomain = z
  .object({
    id: Uuid,
    channelId: Uuid,
    hostname: z.string(),
    status: z.enum(['pending', 'verified']),
    isPrimary: z.boolean(),
    /** DNS record to create while pending. */
    verificationRecord: z.object({ type: z.literal('TXT'), name: z.string(), value: z.string() }).nullable(),
    verifiedAt: Timestamp.nullable(),
    lastCheckAt: Timestamp.nullable(),
    lastCheckError: z.string().nullable(),
  })
  .openapi('StoreDomain');
export type StoreDomain = z.infer<typeof StoreDomain>;
export const AddDomainRequest = z.object({ channelId: Uuid, hostname: Hostname }).openapi('AddDomainRequest');
export type AddDomainRequest = z.infer<typeof AddDomainRequest>;

// ---------------------------------------------------------------- segments

export const SegmentDefinition = z
  .object({
    minOrders: z.number().int().min(1).max(10_000).nullable().default(null),
    minSpentMinor: MinorAmount.nullable().default(null),
    orderedWithinDays: z.number().int().min(1).max(3650).nullable().default(null),
    registeredWithinDays: z.number().int().min(1).max(3650).nullable().default(null),
    /** Only customers whose latest consent for this channel is granted. */
    consentChannel: z.enum(['email', 'sms', 'whatsapp']).nullable().default(null),
  })
  .openapi('SegmentDefinition');
export type SegmentDefinition = z.infer<typeof SegmentDefinition>;
export const Segment = z
  .object({ id: Uuid, name: z.string(), definition: SegmentDefinition, customerCount: z.number().int(), version: Version, createdAt: Timestamp, updatedAt: Timestamp })
  .openapi('Segment');
export type Segment = z.infer<typeof Segment>;
export const SaveSegmentRequest = z
  .object({ name: z.string().trim().min(1).max(80), definition: SegmentDefinition, version: Version.optional() })
  .openapi('SaveSegmentRequest');
export type SaveSegmentRequest = z.infer<typeof SaveSegmentRequest>;
export const SegmentMembers = z
  .object({ count: z.number().int(), items: z.array(z.object({ id: Uuid, displayName: z.string(), email: z.string() })), nextCursor: z.string().nullable() })
  .openapi('SegmentMembers');

// ---------------------------------------------------------------- campaigns

export const Campaign = z
  .object({
    id: Uuid,
    name: z.string(),
    channel: z.enum(['email', 'sms', 'whatsapp']),
    segment: z.object({ id: Uuid, name: z.string() }),
    subject: z.string().nullable(),
    body: z.string(),
    status: z.enum(['draft', 'prepared']),
    preparedAt: Timestamp.nullable(),
    recipientCount: z.number().int(),
    excludedNoConsent: z.number().int(),
    /** Sending needs a notification connector (Phase 11); recipients stay not_sent. */
    sendBlockedReason: z.string(),
    version: Version,
    createdAt: Timestamp,
  })
  .openapi('Campaign');
export type Campaign = z.infer<typeof Campaign>;
export const CampaignPage = pageOf(Campaign).openapi('CampaignPage');
export const SaveCampaignRequest = z
  .object({
    name: z.string().trim().min(1).max(120),
    channel: z.enum(['email', 'sms', 'whatsapp']),
    segmentId: Uuid,
    subject: z.string().trim().max(150).nullable().default(null),
    body: z.string().trim().min(1).max(5000),
    version: Version.optional(),
  })
  .refine((c) => c.channel !== 'email' || !!c.subject, { message: 'E-mail campaigns need a subject', path: ['subject'] })
  .openapi('SaveCampaignRequest');
export type SaveCampaignRequest = z.infer<typeof SaveCampaignRequest>;

// ---------------------------------------------------------------- discounts

export const Discount = z
  .object({
    id: Uuid,
    name: z.string(),
    code: z.string().nullable(),
    mode: z.enum(['percent', 'fixed']),
    value: z.string(),
    currency: CurrencyCode.nullable(),
    minSubtotalMinor: MinorAmount.nullable(),
    startsAt: Timestamp,
    endsAt: Timestamp.nullable(),
    usageLimit: z.number().int().nullable(),
    perCustomerLimit: z.number().int().nullable(),
    segment: z.object({ id: Uuid, name: z.string() }).nullable(),
    channelIds: z.array(Uuid),
    combinable: z.boolean(),
    status: z.enum(['active', 'disabled']),
    usedCount: z.number().int(),
    /** Derived: scheduled / live / expired / used_up / disabled. */
    state: z.enum(['scheduled', 'live', 'expired', 'used_up', 'disabled']),
    version: Version,
    createdAt: Timestamp,
  })
  .openapi('Discount');
export type Discount = z.infer<typeof Discount>;
export const DiscountPage = pageOf(Discount).openapi('DiscountPage');
export const DiscountListQuery = PageQuery.extend({ q: z.string().trim().max(60).optional() });
export type DiscountListQuery = z.infer<typeof DiscountListQuery>;
export const SaveDiscountRequest = z
  .object({
    name: z.string().trim().min(1).max(120),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9_-]{2,31}$/, '3–32 letters, digits, - or _')
      .nullable()
      .default(null),
    mode: z.enum(['percent', 'fixed']),
    value: Decimal,
    currency: CurrencyCode.nullable().default(null),
    minSubtotalMinor: MinorAmount.nullable().default(null),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime().nullable().default(null),
    usageLimit: z.number().int().min(1).max(10_000_000).nullable().default(null),
    perCustomerLimit: z.number().int().min(1).max(1000).nullable().default(null),
    segmentId: Uuid.nullable().default(null),
    channelIds: z.array(Uuid).max(20).default([]),
    combinable: z.boolean().default(false),
    status: z.enum(['active', 'disabled']).default('active'),
    version: Version.optional(),
  })
  .superRefine((d, ctx) => {
    if (d.mode === 'percent' && Number.parseFloat(d.value) > 100) ctx.addIssue({ code: 'custom', path: ['value'], message: 'At most 100%' });
    if (Number.parseFloat(d.value) <= 0) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Must be more than zero' });
    if (d.mode === 'fixed' && !d.currency) ctx.addIssue({ code: 'custom', path: ['currency'], message: 'A fixed discount needs a currency' });
    if (d.endsAt && d.endsAt <= d.startsAt) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'Must end after it starts' });
  })
  .openapi('SaveDiscountRequest');
export type SaveDiscountRequest = z.infer<typeof SaveDiscountRequest>;
export const ApplyDiscountCodeRequest = z
  .object({ code: z.string().trim().toUpperCase().max(32).nullable() })
  .openapi('ApplyDiscountCodeRequest');
export type ApplyDiscountCodeRequest = z.infer<typeof ApplyDiscountCodeRequest>;

/** Promotions applied to a storefront quote (and why an entered code was not). */
export const AppliedPromotions = z
  .object({
    applied: z.array(z.object({ discountId: Uuid, code: z.string().nullable(), label: z.string(), discountMinor: MinorAmount })),
    code: z.string().nullable(),
    codeProblem: z.string().nullable(),
  })
  .openapi('AppliedPromotions');
export type AppliedPromotions = z.infer<typeof AppliedPromotions>;

export const Attribution = z
  .object({
    source: z.string().trim().max(100).nullable().default(null),
    medium: z.string().trim().max(100).nullable().default(null),
    campaign: z.string().trim().max(100).nullable().default(null),
    landingPath: z.string().trim().max(300).nullable().default(null),
  })
  .openapi('Attribution');
export type Attribution = z.infer<typeof Attribution>;

// ---------------------------------------------------------------- reports

export const ReportKey = z.enum(['sales', 'metal_weight', 'stock_age', 'order_sync', 'conversion', 'channels', 'attribution']);
export type ReportKey = z.infer<typeof ReportKey>;
export const ReportMetric = z.object({ key: z.string(), label: z.string(), unit: z.enum(['count', 'money', 'grams', 'percent', 'days', 'quantity']), formula: z.string() });
export const ReportDefinition = z
  .object({
    key: ReportKey,
    title: z.string(),
    description: z.string(),
    dimensions: z.array(z.object({ key: z.string(), label: z.string() })),
    metrics: z.array(ReportMetric),
    source: z.string(),
    filters: z.array(z.enum(['date', 'channel', 'location'])),
    notes: z.array(z.string()),
  })
  .openapi('ReportDefinition');
export type ReportDefinition = z.infer<typeof ReportDefinition>;
export const ReportQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  channelId: Uuid.optional(),
  locationId: Uuid.optional(),
  format: z.enum(['json', 'csv']).default('json'),
});
export type ReportQuery = z.infer<typeof ReportQuery>;
export const ReportResult = z
  .object({
    definition: ReportDefinition,
    filters: z.object({ from: z.string(), to: z.string(), timezone: z.string(), channelId: Uuid.nullable(), locationId: Uuid.nullable() }),
    rows: z.array(z.record(z.union([z.string(), z.number(), z.null()]))),
    totals: z.record(z.union([z.string(), z.number(), z.null()])),
    currency: z.string().nullable(),
    generatedAt: Timestamp,
  })
  .openapi('ReportResult');
export type ReportResult = z.infer<typeof ReportResult>;
export const ReportList = z.object({ items: z.array(ReportDefinition) }).openapi('ReportList');

/** The report catalogue: every metric carries its formula; nothing here needs data the platform does not have. */
export const REPORTS: Record<ReportKey, Omit<ReportDefinition, 'key'>> = {
  sales: {
    title: 'Sales',
    description: 'Confirmed orders per day, with discounts and refunds.',
    dimensions: [{ key: 'day', label: 'Day (store time zone)' }],
    metrics: [
      { key: 'orders', label: 'Orders', unit: 'count', formula: 'count of orders confirmed that day (status confirmed, by confirmation time)' },
      { key: 'gross', label: 'Gross sales', unit: 'money', formula: 'Σ order subtotal of those orders' },
      { key: 'discounts', label: 'Discounts', unit: 'money', formula: 'Σ order discount (rule discounts + promotions)' },
      { key: 'tax', label: 'Tax', unit: 'money', formula: 'Σ order tax' },
      { key: 'total', label: 'Order total', unit: 'money', formula: 'Σ order total = gross − discounts + tax' },
      { key: 'refunds', label: 'Refunds', unit: 'money', formula: 'Σ refunds that succeeded that day' },
      { key: 'net', label: 'Net', unit: 'money', formula: 'order total − refunds' },
    ],
    source: 'orders, refunds',
    filters: ['date', 'channel'],
    notes: ['Amounts are per store currency; orders in other currencies are excluded and counted in the notes.'],
  },
  metal_weight: {
    title: 'Metal weight sold',
    description: 'Grams of metal sold, by metal and purity, from the frozen order price snapshots.',
    dimensions: [
      { key: 'metal', label: 'Metal' },
      { key: 'purity', label: 'Purity' },
    ],
    metrics: [
      { key: 'pieces', label: 'Pieces', unit: 'quantity', formula: 'Σ line quantity of confirmed orders' },
      { key: 'netG', label: 'Net grams', unit: 'grams', formula: 'Σ snapshot net weight × quantity' },
      { key: 'grossG', label: 'Gross grams', unit: 'grams', formula: 'Σ snapshot gross weight × quantity' },
    ],
    source: 'order lines (price snapshot measurements)',
    filters: ['date', 'channel'],
    notes: ['Lines without jewellery measurements are not included.'],
  },
  stock_age: {
    title: 'Stock age',
    description: 'Sellable stock on hand by age.',
    dimensions: [{ key: 'bucket', label: 'Age' }],
    metrics: [
      { key: 'pieces', label: 'Serialized pieces', unit: 'count', formula: 'pieces in stock, aged by days since the piece was first received' },
      { key: 'units', label: 'Other units', unit: 'quantity', formula: 'on-hand of non-serialized stock, aged by days since the last receipt at that location (approximation: no FIFO layers)' },
    ],
    source: 'serial items, stock balances, stock ledger',
    filters: ['location'],
    notes: ['Age buckets: 0–30, 31–90, 91–180, 181–365, over 365 days.'],
  },
  order_sync: {
    title: 'ERP order sync',
    description: 'Status of orders sent to ERP connections.',
    dimensions: [
      { key: 'connection', label: 'Connection' },
      { key: 'status', label: 'Status' },
    ],
    metrics: [{ key: 'commands', label: 'Orders', unit: 'count', formula: 'count of ORDER export commands created in the period, by current status' }],
    source: 'outbound commands',
    filters: ['date'],
    notes: [],
  },
  conversion: {
    title: 'Cart conversion',
    description: 'Carts created and how many became orders.',
    dimensions: [{ key: 'day', label: 'Day (store time zone)' }],
    metrics: [
      { key: 'carts', label: 'Carts', unit: 'count', formula: 'carts created that day' },
      { key: 'converted', label: 'Converted', unit: 'count', formula: 'of those carts, how many became an order' },
      { key: 'paid', label: 'Paid', unit: 'count', formula: 'of those orders, how many were confirmed' },
      { key: 'rate', label: 'Cart → paid order', unit: 'percent', formula: 'paid ÷ carts × 100' },
    ],
    source: 'carts, orders',
    filters: ['date', 'channel'],
    notes: ['There is no visit tracking, so this is not a visit conversion rate.'],
  },
  channels: {
    title: 'Channels and fulfilment',
    description: 'Orders per channel and fulfilment state.',
    dimensions: [
      { key: 'channel', label: 'Channel' },
      { key: 'fulfillment', label: 'Fulfilment' },
    ],
    metrics: [
      { key: 'orders', label: 'Orders', unit: 'count', formula: 'confirmed orders created in the period' },
      { key: 'total', label: 'Order total', unit: 'money', formula: 'Σ order total' },
    ],
    source: 'orders',
    filters: ['date'],
    notes: [],
  },
  attribution: {
    title: 'Attribution',
    description: 'Confirmed storefront orders by marketing source (UTM) captured at checkout.',
    dimensions: [
      { key: 'source', label: 'Source' },
      { key: 'medium', label: 'Medium' },
      { key: 'campaign', label: 'Campaign' },
    ],
    metrics: [
      { key: 'orders', label: 'Orders', unit: 'count', formula: 'confirmed orders with that attribution' },
      { key: 'total', label: 'Order total', unit: 'money', formula: 'Σ order total' },
    ],
    source: 'orders (attribution)',
    filters: ['date', 'channel'],
    notes: ['No acquisition cost (CAC/ROAS) is shown: ad spend is not recorded in the platform.'],
  },
};
