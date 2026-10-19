import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { orders } from './orders-schema';
import { priceBooks } from './pricing-schema';
import { tenants, users } from './schema';

// Phase 08 B2B wholesale (ADR-023).
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });
const id = () => uuid('id').primaryKey().defaultRandom();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });
const version = () => integer('version').notNull().default(0);
const minor = (name: string) => bigint(name, { mode: 'bigint' });

export const companies = pgTable(
  'companies',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    code: text('code').notNull(),
    /** Format-checked only; not verified against any registry. */
    gstin: text('gstin'),
    status: text('status', { enum: ['active', 'on_hold', 'inactive'] })
      .notNull()
      .default('active'),
    paymentTerms: text('payment_terms', { enum: ['prepaid', 'on_account'] })
      .notNull()
      .default('on_account'),
    currency: text('currency').notNull(),
    creditLimitMinor: minor('credit_limit_minor'),
    minOrderMinor: minor('min_order_minor'),
    accountingAuthority: text('accounting_authority', { enum: ['commerce', 'erp'] })
      .notNull()
      .default('commerce'),
    salesRepUserId: uuid('sales_rep_user_id').references(() => users.id, { onDelete: 'set null' }),
    priceBookId: uuid('price_book_id'),
    catalogMode: text('catalog_mode', { enum: ['all', 'collections'] })
      .notNull()
      .default('all'),
    collectionIds: uuid('collection_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('companies_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('companies_tenant_code_uq').on(t.tenantId, t.code),
    foreignKey({
      columns: [t.tenantId, t.priceBookId],
      foreignColumns: [priceBooks.tenantId, priceBooks.id],
    }),
    check('companies_status_ck', sql`${t.status} in ('active','on_hold','inactive')`),
    check('companies_terms_ck', sql`${t.paymentTerms} in ('prepaid','on_account')`),
    check(
      'companies_limits_ck',
      sql`coalesce(${t.creditLimitMinor}, 0) >= 0 and coalesce(${t.minOrderMinor}, 0) >= 0`,
    ),
    check(
      'companies_gstin_ck',
      sql`${t.gstin} is null or ${t.gstin} ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'`,
    ),
  ],
);

export const companyLocations = pgTable(
  'company_locations',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id').notNull(),
    name: text('name').notNull(),
    code: text('code').notNull(),
    address: jsonb('address').notNull(),
    status: text('status', { enum: ['active', 'inactive'] })
      .notNull()
      .default('active'),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('company_locations_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('company_locations_code_uq').on(t.companyId, t.code),
    foreignKey({
      columns: [t.tenantId, t.companyId],
      foreignColumns: [companies.tenantId, companies.id],
    }).onDelete('cascade'),
  ],
);

/** A user's role in a company. Invitation token: SHA-256 only, single use, expires. */
export const companyBuyers = pgTable(
  'company_buyers',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: ['buyer', 'approver', 'admin'] }).notNull(),
    /** null = all company locations */
    locationIds: uuid('location_ids').array(),
    orderLimitMinor: minor('order_limit_minor'),
    status: text('status', { enum: ['invited', 'active', 'disabled'] })
      .notNull()
      .default('invited'),
    invitationTokenHash: text('invitation_token_hash'),
    invitationExpiresAt: ts('invitation_expires_at'),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    acceptedAt: ts('accepted_at'),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('company_buyers_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('company_buyers_company_email_uq').on(t.companyId, t.email),
    uniqueIndex('company_buyers_company_user_uq').on(t.companyId, t.userId),
    uniqueIndex('company_buyers_invitation_uq').on(t.invitationTokenHash),
    index('company_buyers_user_idx').on(t.userId),
    foreignKey({
      columns: [t.tenantId, t.companyId],
      foreignColumns: [companies.tenantId, companies.id],
    }).onDelete('cascade'),
    check('company_buyers_email_ck', sql`${t.email} = lower(${t.email})`),
    check('company_buyers_role_ck', sql`${t.role} in ('buyer','approver','admin')`),
    check('company_buyers_status_ck', sql`${t.status} in ('invited','active','disabled')`),
    check('company_buyers_active_user_ck', sql`${t.status} = 'invited' or ${t.userId} is not null`),
    check('company_buyers_limit_ck', sql`coalesce(${t.orderLimitMinor}, 0) >= 0`),
  ],
);

/** Append-only credit ledger: + raises exposure (owed), − lowers it. */
export const creditEntries = pgTable(
  'credit_entries',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id').notNull(),
    type: text('type', {
      enum: ['order_charge', 'order_release', 'payment', 'advance', 'adjustment'],
    }).notNull(),
    amountMinor: minor('amount_minor').notNull(),
    reference: text('reference'),
    orderId: uuid('order_id'),
    note: text('note'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('credit_entries_company_idx').on(t.companyId, t.createdAt.desc()),
    uniqueIndex('credit_entries_order_type_uq')
      .on(t.orderId, t.type)
      .where(sql`${t.orderId} is not null`),
    foreignKey({ columns: [t.tenantId, t.companyId], foreignColumns: [companies.tenantId, companies.id] }),
    foreignKey({ columns: [t.tenantId, t.orderId], foreignColumns: [orders.tenantId, orders.id] }),
    check(
      'credit_entries_type_ck',
      sql`${t.type} in ('order_charge','order_release','payment','advance','adjustment')`,
    ),
    check(
      'credit_entries_sign_ck',
      sql`(${t.type} in ('order_charge') and ${t.amountMinor} > 0) or (${t.type} in ('order_release','payment','advance') and ${t.amountMinor} < 0) or (${t.type} = 'adjustment' and ${t.amountMinor} <> 0)`,
    ),
  ],
);

export const rfqs = pgTable(
  'rfqs',
  {
    id: id(),
    tenantId: tenantId(),
    number: text('number').notNull(),
    companyId: uuid('company_id').notNull(),
    buyerId: uuid('buyer_id').notNull(),
    locationId: uuid('location_id'),
    lines: jsonb('lines').notNull(),
    note: text('note'),
    neededBy: ts('needed_by'),
    status: text('status', { enum: ['submitted', 'quoted', 'accepted', 'declined', 'expired', 'cancelled'] })
      .notNull()
      .default('submitted'),
    quotationId: uuid('quotation_id'),
    declineReason: text('decline_reason'),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('rfqs_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('rfqs_tenant_number_uq').on(t.tenantId, t.number),
    index('rfqs_company_idx').on(t.companyId, t.createdAt.desc()),
    foreignKey({ columns: [t.tenantId, t.companyId], foreignColumns: [companies.tenantId, companies.id] }),
    foreignKey({
      columns: [t.tenantId, t.buyerId],
      foreignColumns: [companyBuyers.tenantId, companyBuyers.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.locationId],
      foreignColumns: [companyLocations.tenantId, companyLocations.id],
    }),
    check(
      'rfqs_status_ck',
      sql`${t.status} in ('submitted','quoted','accepted','declined','expired','cancelled')`,
    ),
  ],
);

/** Append-only negotiation thread. */
export const rfqMessages = pgTable(
  'rfq_messages',
  {
    id: id(),
    tenantId: tenantId(),
    rfqId: uuid('rfq_id').notNull(),
    author: text('author', { enum: ['buyer', 'staff'] }).notNull(),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('rfq_messages_rfq_idx').on(t.rfqId, t.createdAt),
    foreignKey({ columns: [t.tenantId, t.rfqId], foreignColumns: [rfqs.tenantId, rfqs.id] }).onDelete(
      'cascade',
    ),
    check('rfq_messages_author_ck', sql`${t.author} in ('buyer','staff')`),
  ],
);

export const B2B_RLS_TABLES = [
  'companies',
  'company_locations',
  'company_buyers',
  'credit_entries',
  'rfqs',
  'rfq_messages',
] as const;
