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
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { variants } from './catalog-schema';
import { purityDefinitions } from './jewellery-schema';
import { channels, tenants, users } from './schema';

// Phase 06 metal rates and pricing (ADR-021).
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });
const id = () => uuid('id').primaryKey().defaultRandom();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });
const version = () => integer('version').notNull().default(0);
/** Major-unit amounts and rates per gram: exact NUMERIC(20,6), returned as strings. */
const money6 = (name: string) => numeric(name, { precision: 20, scale: 6 });
const minor = (name: string) => bigint(name, { mode: 'bigint' });
const METALS = ['gold', 'silver', 'platinum', 'palladium', 'other'] as const;

export const pricingSettings = pgTable(
  'pricing_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    quoteTtlMinutes: integer('quote_ttl_minutes').notNull().default(15),
    rateMaxAgeMinutes: integer('rate_max_age_minutes').notNull().default(1440),
    stalePolicy: text('stale_policy', { enum: ['block', 'use_last_approved'] })
      .notNull()
      .default('block'),
    ruleReviewRequired: boolean('rule_review_required').notNull().default(true),
    version: version(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('pricing_settings_ttl_ck', sql`${t.quoteTtlMinutes} between 1 and 10080`),
    check('pricing_settings_age_ck', sql`${t.rateMaxAgeMinutes} between 1 and 44640`),
    check('pricing_settings_stale_ck', sql`${t.stalePolicy} in ('block','use_last_approved')`),
  ],
);

export const rateSources = pgTable(
  'rate_sources',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['manual', 'provider'] }).notNull(),
    providerKey: text('provider_key'),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    /** Secret-store reference only — never a secret value. */
    credentialRef: text('credential_ref'),
    licenceRef: text('licence_ref'),
    adapterState: jsonb('adapter_state')
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastPulledAt: ts('last_pulled_at'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('rate_sources_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('rate_sources_manual_uq')
      .on(t.tenantId)
      .where(sql`${t.kind} = 'manual'`),
    uniqueIndex('rate_sources_tenant_name_uq').on(t.tenantId, sql`lower(${t.name})`),
    check('rate_sources_kind_ck', sql`(${t.kind} = 'manual') = (${t.providerKey} is null)`),
    check('rate_sources_status_ck', sql`${t.status} in ('active','disabled')`),
    check(
      'rate_sources_credential_ref_ck',
      sql`${t.credentialRef} is null or ${t.credentialRef} ~ '^(vault|env|secretsmanager):'`,
    ),
  ],
);

/**
 * Append-only rate proposals (maker-checker). Values never change after insert (trigger); a proposal is decided
 * once. "Rolling back" a rate means proposing the previous value again.
 */
export const metalRates = pgTable(
  'metal_rates',
  {
    id: id(),
    tenantId: tenantId(),
    sourceId: uuid('source_id').notNull(),
    metal: text('metal', { enum: METALS }).notNull(),
    purityId: uuid('purity_id').notNull(),
    currency: text('currency').notNull(),
    ratePerG: money6('rate_per_g').notNull(),
    inputValue: text('input_value').notNull(),
    inputUnit: text('input_unit', { enum: ['per_g', 'per_10g', 'per_kg'] }).notNull(),
    sourceAsOf: ts('source_as_of').notNull(),
    /** Requested start; null = from approval. Set at approval when null. */
    effectiveFrom: ts('effective_from'),
    status: text('status', { enum: ['proposed', 'approved', 'rejected'] })
      .notNull()
      .default('proposed'),
    reason: text('reason'),
    proposedBy: uuid('proposed_by').references(() => users.id, { onDelete: 'set null' }),
    proposedAt: ts('proposed_at').notNull().defaultNow(),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: ts('decided_at'),
    decisionNote: text('decision_note'),
    staleNotifiedAt: ts('stale_notified_at'),
  },
  (t) => [
    index('metal_rates_current_idx').on(t.tenantId, t.purityId, t.currency, t.status, t.effectiveFrom.desc()),
    index('metal_rates_tenant_proposed_idx').on(t.tenantId, t.proposedAt.desc()),
    foreignKey({ columns: [t.tenantId, t.sourceId], foreignColumns: [rateSources.tenantId, rateSources.id] }),
    foreignKey({
      columns: [t.tenantId, t.purityId],
      foreignColumns: [purityDefinitions.tenantId, purityDefinitions.id],
    }),
    check('metal_rates_positive_ck', sql`${t.ratePerG} > 0`),
    check('metal_rates_currency_ck', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('metal_rates_status_ck', sql`${t.status} in ('proposed','approved','rejected')`),
    check('metal_rates_decided_ck', sql`(${t.status} = 'proposed') = (${t.decidedAt} is null)`),
    // Separation of duties enforced by the database as well as the service.
    check('metal_rates_four_eyes_ck', sql`${t.decidedBy} is null or ${t.decidedBy} <> ${t.proposedBy}`),
    check('metal_rates_effective_ck', sql`${t.status} <> 'approved' or ${t.effectiveFrom} is not null`),
  ],
);

export const taxRules = pgTable(
  'tax_rules',
  {
    id: id(),
    tenantId: tenantId(),
    label: text('label').notNull(),
    ratePercent: numeric('rate_percent', { precision: 7, scale: 4 }).notNull(),
    appliesTo: text('applies_to').array().notNull(),
    status: text('status', { enum: ['pending_validation', 'validated', 'inactive'] })
      .notNull()
      .default('pending_validation'),
    validationNote: text('validation_note'),
    validatedBy: uuid('validated_by').references(() => users.id, { onDelete: 'set null' }),
    validatedAt: ts('validated_at'),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('tax_rules_tenant_id_uq').on(t.tenantId, t.id),
    check('tax_rules_rate_ck', sql`${t.ratePercent} >= 0 and ${t.ratePercent} <= 100`),
    check('tax_rules_status_ck', sql`${t.status} in ('pending_validation','validated','inactive')`),
  ],
);

export const priceBooks = pgTable(
  'price_books',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    channelId: uuid('channel_id'),
    priority: integer('priority').notNull().default(0),
    currency: text('currency').notNull(),
    status: text('status', { enum: ['active', 'archived'] })
      .notNull()
      .default('active'),
    effectiveFrom: ts('effective_from'),
    effectiveTo: ts('effective_to'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('price_books_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('price_books_tenant_name_uq').on(t.tenantId, sql`lower(${t.name})`),
    foreignKey({ columns: [t.tenantId, t.channelId], foreignColumns: [channels.tenantId, channels.id] }),
    check('price_books_currency_ck', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('price_books_status_ck', sql`${t.status} in ('active','archived')`),
    check(
      'price_books_window_ck',
      sql`${t.effectiveFrom} is null or ${t.effectiveTo} is null or ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
  ],
);

/** Fixed list prices per variant (major units), for standard/general-commerce pricing. */
export const priceListEntries = pgTable(
  'price_list_entries',
  {
    tenantId: tenantId(),
    bookId: uuid('book_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    amount: money6('amount').notNull(),
    /** B2B minimum order quantity in pieces (null = none). */
    minQuantity: integer('min_quantity'),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.variantId] }),
    foreignKey({
      columns: [t.tenantId, t.bookId],
      foreignColumns: [priceBooks.tenantId, priceBooks.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.variantId],
      foreignColumns: [variants.tenantId, variants.id],
    }).onDelete('cascade'),
    check('price_list_entries_amount_ck', sql`${t.amount} >= 0`),
    check('price_list_entries_moq_ck', sql`${t.minQuantity} is null or ${t.minQuantity} > 0`),
  ],
);

export const priceRules = pgTable(
  'price_rules',
  {
    id: id(),
    tenantId: tenantId(),
    bookId: uuid('book_id').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'retired'] })
      .notNull()
      .default('active'),
    retireReason: text('retire_reason'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    retiredAt: ts('retired_at'),
  },
  (t) => [
    unique('price_rules_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('price_rules_book_name_uq').on(t.bookId, sql`lower(${t.name})`),
    foreignKey({ columns: [t.tenantId, t.bookId], foreignColumns: [priceBooks.tenantId, priceBooks.id] }),
    check('price_rules_status_ck', sql`${t.status} in ('active','retired')`),
  ],
);

/** Rule versions: a draft is editable; once published it is immutable (trigger) and only changes status. */
export const priceRuleVersions = pgTable(
  'price_rule_versions',
  {
    id: id(),
    tenantId: tenantId(),
    ruleId: uuid('rule_id').notNull(),
    version: integer('version').notNull(),
    status: text('status', { enum: ['draft', 'published', 'superseded', 'retired'] })
      .notNull()
      .default('draft'),
    priority: integer('priority').notNull(),
    conditions: jsonb('conditions').notNull(),
    definition: jsonb('definition').notNull(),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    publishedBy: uuid('published_by').references(() => users.id, { onDelete: 'set null' }),
    publishedAt: ts('published_at'),
    lockVersion: integer('lock_version').notNull().default(0),
  },
  (t) => [
    unique('price_rule_versions_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('price_rule_versions_rule_version_uq').on(t.ruleId, t.version),
    uniqueIndex('price_rule_versions_one_draft_uq')
      .on(t.ruleId)
      .where(sql`${t.status} = 'draft'`),
    uniqueIndex('price_rule_versions_one_published_uq')
      .on(t.ruleId)
      .where(sql`${t.status} = 'published'`),
    foreignKey({ columns: [t.tenantId, t.ruleId], foreignColumns: [priceRules.tenantId, priceRules.id] }),
    check('price_rule_versions_status_ck', sql`${t.status} in ('draft','published','superseded','retired')`),
    check('price_rule_versions_published_ck', sql`${t.status} = 'draft' or ${t.publishedAt} is not null`),
  ],
);

/** Immutable server-calculated quotes (breakdown, rate IDs and rule versions frozen at creation). */
export const priceQuotes = pgTable(
  'price_quotes',
  {
    id: id(),
    tenantId: tenantId(),
    channelId: uuid('channel_id'),
    origin: text('origin', { enum: ['admin', 'storefront'] }).notNull(),
    currency: text('currency').notNull(),
    lineInputs: jsonb('line_inputs').notNull(),
    lines: jsonb('lines').notNull(),
    subtotalMinor: minor('subtotal_minor').notNull(),
    discountMinor: minor('discount_minor').notNull(),
    taxMinor: minor('tax_minor').notNull(),
    totalMinor: minor('total_minor').notNull(),
    warnings: jsonb('warnings').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    supersededBy: uuid('superseded_by'),
    supersededAt: ts('superseded_at'),
  },
  (t) => [
    unique('price_quotes_tenant_id_uq').on(t.tenantId, t.id),
    index('price_quotes_tenant_created_idx').on(t.tenantId, t.createdAt.desc()),
    foreignKey({ columns: [t.tenantId, t.channelId], foreignColumns: [channels.tenantId, channels.id] }),
    check('price_quotes_origin_ck', sql`${t.origin} in ('admin','storefront')`),
    check('price_quotes_expiry_ck', sql`${t.expiresAt} > ${t.createdAt}`),
    check(
      'price_quotes_total_ck',
      sql`${t.totalMinor} = ${t.subtotalMinor} - ${t.discountMinor} + ${t.taxMinor}`,
    ),
  ],
);

export const PRICING_RLS_TABLES = [
  'pricing_settings',
  'rate_sources',
  'metal_rates',
  'tax_rules',
  'price_books',
  'price_list_entries',
  'price_rules',
  'price_rule_versions',
  'price_quotes',
] as const;
