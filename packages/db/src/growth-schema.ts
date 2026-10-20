import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { customers } from './b2c-schema';
import { orders } from './orders-schema';
import { channels, tenants, users } from './schema';

// Phase 10 online store content, discounts, segments, campaigns (ADR-025).
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });
const id = () => uuid('id').primaryKey().defaultRandom();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });
const version = () => integer('version').notNull().default(0);
const minor = (name: string) => bigint(name, { mode: 'bigint' });

/**
 * One editable piece of a storefront: its theme, a menu, a page or the announcement banner. Staff edit `draft`;
 * publishing snapshots it as an immutable version and copies it to `published`, which is all shoppers see.
 */
export const siteDocuments = pgTable(
  'site_documents',
  {
    id: id(),
    tenantId: tenantId(),
    channelId: uuid('channel_id').notNull(),
    kind: text('kind', { enum: ['theme', 'menu', 'page', 'banner'] }).notNull(),
    /** Page slug, menu name (header/footer) or "main" for the theme and banner. */
    key: text('key').notNull(),
    draft: jsonb('draft').notNull(),
    draftUpdatedAt: ts('draft_updated_at').notNull().defaultNow(),
    draftUpdatedBy: uuid('draft_updated_by').references(() => users.id, { onDelete: 'set null' }),
    published: jsonb('published'),
    publishedVersion: integer('published_version'),
    publishedAt: ts('published_at'),
    /** Unpublished documents (e.g. a withdrawn page) keep their history but are not served. */
    live: boolean('live').notNull().default(false),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('site_documents_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('site_documents_key_uq').on(t.tenantId, t.channelId, t.kind, t.key),
    foreignKey({ columns: [t.tenantId, t.channelId], foreignColumns: [channels.tenantId, channels.id] }),
    check('site_documents_kind_ck', sql`${t.kind} in ('theme','menu','page','banner')`),
    check('site_documents_live_ck', sql`not ${t.live} or ${t.published} is not null`),
  ],
);

/** Immutable published versions (rollback = publish an old version again, as a new version). */
export const siteDocumentVersions = pgTable(
  'site_document_versions',
  {
    id: id(),
    tenantId: tenantId(),
    documentId: uuid('document_id').notNull(),
    version: integer('version').notNull(),
    content: jsonb('content').notNull(),
    note: text('note'),
    publishedBy: uuid('published_by').references(() => users.id, { onDelete: 'set null' }),
    publishedAt: ts('published_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('site_document_versions_uq').on(t.documentId, t.version),
    foreignKey({
      columns: [t.tenantId, t.documentId],
      foreignColumns: [siteDocuments.tenantId, siteDocuments.id],
    }).onDelete('cascade'),
  ],
);

export const redirects = pgTable(
  'redirects',
  {
    id: id(),
    tenantId: tenantId(),
    channelId: uuid('channel_id').notNull(),
    fromPath: text('from_path').notNull(),
    toPath: text('to_path').notNull(),
    statusCode: integer('status_code').notNull().default(301),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('redirects_from_uq').on(t.tenantId, t.channelId, t.fromPath),
    foreignKey({
      columns: [t.tenantId, t.channelId],
      foreignColumns: [channels.tenantId, channels.id],
    }).onDelete('cascade'),
    check('redirects_code_ck', sql`${t.statusCode} in (301, 302)`),
    check('redirects_paths_ck', sql`${t.fromPath} like '/%' and ${t.fromPath} <> ${t.toPath}`),
  ],
);

export const segments = pgTable(
  'segments',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    definition: jsonb('definition').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('segments_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('segments_name_uq').on(t.tenantId, t.name),
  ],
);

export const discounts = pgTable(
  'discounts',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    /** Upper-case code shoppers enter; null = applies automatically. */
    code: text('code'),
    mode: text('mode', { enum: ['percent', 'fixed'] }).notNull(),
    /** Percentage (0–100) or major-unit amount in `currency`. */
    value: numeric('value', { precision: 20, scale: 6 }).notNull(),
    currency: text('currency'),
    minSubtotalMinor: minor('min_subtotal_minor'),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at'),
    usageLimit: integer('usage_limit'),
    perCustomerLimit: integer('per_customer_limit'),
    segmentId: uuid('segment_id'),
    /** Empty = every storefront channel. */
    channelIds: uuid('channel_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    combinable: boolean('combinable').notNull().default(false),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    usedCount: integer('used_count').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('discounts_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('discounts_code_uq')
      .on(t.tenantId, t.code)
      .where(sql`${t.code} is not null`),
    foreignKey({ columns: [t.tenantId, t.segmentId], foreignColumns: [segments.tenantId, segments.id] }),
    check('discounts_mode_ck', sql`${t.mode} in ('percent','fixed')`),
    check('discounts_value_ck', sql`${t.value} > 0 and (${t.mode} <> 'percent' or ${t.value} <= 100)`),
    check('discounts_currency_ck', sql`${t.mode} <> 'fixed' or ${t.currency} is not null`),
    check('discounts_code_ck', sql`${t.code} is null or ${t.code} ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'`),
    check('discounts_window_ck', sql`${t.endsAt} is null or ${t.endsAt} > ${t.startsAt}`),
    check(
      'discounts_limits_ck',
      sql`coalesce(${t.usageLimit}, 1) > 0 and coalesce(${t.perCustomerLimit}, 1) > 0`,
    ),
    check(
      'discounts_used_ck',
      sql`${t.usedCount} >= 0 and (${t.usageLimit} is null or ${t.usedCount} <= ${t.usageLimit})`,
    ),
  ],
);

/** One row per discount used on an order (immutable). */
export const discountRedemptions = pgTable(
  'discount_redemptions',
  {
    id: id(),
    tenantId: tenantId(),
    discountId: uuid('discount_id').notNull(),
    orderId: uuid('order_id').notNull(),
    customerId: uuid('customer_id'),
    code: text('code'),
    amountMinor: minor('amount_minor').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('discount_redemptions_uq').on(t.discountId, t.orderId),
    index('discount_redemptions_customer_idx').on(t.discountId, t.customerId),
    foreignKey({ columns: [t.tenantId, t.discountId], foreignColumns: [discounts.tenantId, discounts.id] }),
    foreignKey({ columns: [t.tenantId, t.orderId], foreignColumns: [orders.tenantId, orders.id] }),
    foreignKey({ columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    check('discount_redemptions_amount_ck', sql`${t.amountMinor} >= 0`),
  ],
);

export const campaigns = pgTable(
  'campaigns',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    channel: text('channel', { enum: ['email', 'sms', 'whatsapp'] }).notNull(),
    segmentId: uuid('segment_id').notNull(),
    subject: text('subject'),
    body: text('body').notNull(),
    status: text('status', { enum: ['draft', 'prepared'] })
      .notNull()
      .default('draft'),
    preparedAt: ts('prepared_at'),
    preparedBy: uuid('prepared_by').references(() => users.id, { onDelete: 'set null' }),
    recipientCount: integer('recipient_count').notNull().default(0),
    excludedNoConsent: integer('excluded_no_consent').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('campaigns_tenant_id_uq').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.segmentId], foreignColumns: [segments.tenantId, segments.id] }),
    check('campaigns_channel_ck', sql`${t.channel} in ('email','sms','whatsapp')`),
    check('campaigns_status_ck', sql`${t.status} in ('draft','prepared')`),
  ],
);

/** Audience snapshot of a prepared campaign: only customers whose latest consent for the channel is granted. */
export const campaignRecipients = pgTable(
  'campaign_recipients',
  {
    id: id(),
    tenantId: tenantId(),
    campaignId: uuid('campaign_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    address: text('address').notNull(),
    status: text('status', { enum: ['not_sent', 'sent', 'failed'] })
      .notNull()
      .default('not_sent'),
    statusReason: text('status_reason'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('campaign_recipients_uq').on(t.campaignId, t.customerId),
    foreignKey({
      columns: [t.tenantId, t.campaignId],
      foreignColumns: [campaigns.tenantId, campaigns.id],
    }).onDelete('cascade'),
    foreignKey({ columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    check('campaign_recipients_status_ck', sql`${t.status} in ('not_sent','sent','failed')`),
  ],
);

export const GROWTH_RLS_TABLES = [
  'site_documents',
  'site_document_versions',
  'redirects',
  'segments',
  'discounts',
  'discount_redemptions',
  'campaigns',
  'campaign_recipients',
] as const;
