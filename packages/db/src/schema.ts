import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
// Millisecond precision matches JS Date exactly (keyset pagination cursors stay lossless).
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();
const version = () => integer('version').notNull().default(0);

// ---------------------------------------------------------------- identity (global, not tenant-owned)

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: ts('locked_until'),
    lastLoginAt: ts('last_login_at'),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(t.email),
    check('users_email_lower_ck', sql`${t.email} = lower(${t.email})`),
    check('users_status_ck', sql`${t.status} in ('active','disabled')`),
  ],
);

export const platformAdmins = pgTable(
  'platform_admins',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['platform_owner', 'platform_support'] }).notNull(),
    status: text('status', { enum: ['active', 'suspended'] })
      .notNull()
      .default('active'),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('platform_admins_role_ck', sql`${t.role} in ('platform_owner','platform_support')`),
    check('platform_admins_status_ck', sql`${t.status} in ('active','suspended')`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    audience: text('audience', { enum: ['merchant', 'platform', 'buyer'] }).notNull(),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    revokedAt: ts('revoked_at'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_uq').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
    check('sessions_audience_ck', sql`${t.audience} in ('merchant','platform','buyer')`),
  ],
);

// ---------------------------------------------------------------- tenancy

export const tenants = pgTable(
  'tenants',
  {
    id: id(),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    legalName: text('legal_name').notNull(),
    /** Phase 11: owners/admins must have MFA enrolled before using the admin API. */
    requireMfaForAdmins: boolean('require_mfa_for_admins').notNull().default(false),
    status: text('status', { enum: ['provisioning', 'active', 'suspended'] })
      .notNull()
      .default('provisioning'),
    preset: text('preset', {
      enum: ['b2b_jewellery', 'b2c_jewellery', 'hybrid_jewellery', 'general_commerce'],
    }).notNull(),
    countryCode: text('country_code').notNull(),
    defaultCurrency: text('default_currency').notNull(),
    timezone: text('timezone').notNull(),
    defaultLocale: text('default_locale').notNull(),
    contactEmail: text('contact_email'),
    contactPhone: text('contact_phone'),
    suspendedReason: text('suspended_reason'),
    isDemo: boolean('is_demo').notNull().default(false),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('tenants_slug_uq').on(t.slug),
    check('tenants_status_ck', sql`${t.status} in ('provisioning','active','suspended')`),
    check(
      'tenants_preset_ck',
      sql`${t.preset} in ('b2b_jewellery','b2c_jewellery','hybrid_jewellery','general_commerce')`,
    ),
    check('tenants_country_ck', sql`${t.countryCode} ~ '^[A-Z]{2}$'`),
    check('tenants_currency_ck', sql`${t.defaultCurrency} ~ '^[A-Z]{3}$'`),
  ],
);

/** Only explicit overrides are stored; preset defaults come from code (ADR-006). */
export const tenantEntitlements = pgTable(
  'tenant_entitlements',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    featureKey: text('feature_key').notNull(),
    enabled: boolean('enabled').notNull(),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.featureKey] })],
);

export const stores = pgTable(
  'stores',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'inactive'] })
      .notNull()
      .default('active'),
    defaultCurrency: text('default_currency').notNull(),
    timezone: text('timezone').notNull(),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('stores_tenant_code_uq').on(t.tenantId, t.code),
    unique('stores_tenant_id_uq').on(t.tenantId, t.id),
    check('stores_status_ck', sql`${t.status} in ('active','inactive')`),
  ],
);

export const channels = pgTable(
  'channels',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    storeId: uuid('store_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: text('type', { enum: ['b2b_storefront', 'b2c_storefront', 'pos', 'marketplace', 'api'] }).notNull(),
    status: text('status', { enum: ['active', 'inactive'] })
      .notNull()
      .default('active'),
    theme: jsonb('theme').notNull(),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('channels_tenant_code_uq').on(t.tenantId, t.code),
    unique('channels_tenant_id_uq').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.storeId], foreignColumns: [stores.tenantId, stores.id] }).onDelete(
      'cascade',
    ),
    check(
      'channels_type_ck',
      sql`${t.type} in ('b2b_storefront','b2c_storefront','pos','marketplace','api')`,
    ),
    check('channels_status_ck', sql`${t.status} in ('active','inactive')`),
  ],
);

export const channelDomains = pgTable(
  'channel_domains',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').notNull(),
    hostname: text('hostname').notNull(),
    status: text('status', { enum: ['pending', 'verified'] })
      .notNull()
      .default('pending'),
    isPrimary: boolean('is_primary').notNull().default(false),
    verifiedAt: ts('verified_at'),
    /** Phase 10: value expected in the DNS TXT record `_uc-verify.<hostname>`. */
    verificationToken: text('verification_token'),
    lastCheckAt: ts('last_check_at'),
    lastCheckError: text('last_check_error'),
    createdAt: createdAt(),
  },
  (t) => [
    // Global uniqueness: a hostname can resolve to exactly one channel across all tenants.
    uniqueIndex('channel_domains_hostname_uq').on(t.hostname),
    foreignKey({
      columns: [t.tenantId, t.channelId],
      foreignColumns: [channels.tenantId, channels.id],
    }).onDelete('cascade'),
    check('channel_domains_hostname_lower_ck', sql`${t.hostname} = lower(${t.hostname})`),
    check('channel_domains_status_ck', sql`${t.status} in ('pending','verified')`),
  ],
);

export const locations = pgTable(
  'locations',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    storeId: uuid('store_id'),
    parentId: uuid('parent_id'),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: text('type', { enum: ['warehouse', 'branch', 'showroom', 'bin'] }).notNull(),
    status: text('status', { enum: ['active', 'inactive'] })
      .notNull()
      .default('active'),
    address: jsonb('address'),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('locations_tenant_code_uq').on(t.tenantId, t.code),
    unique('locations_tenant_id_uq').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.storeId], foreignColumns: [stores.tenantId, stores.id] }),
    foreignKey({ columns: [t.tenantId, t.parentId], foreignColumns: [t.tenantId, t.id] }),
    check('locations_type_ck', sql`${t.type} in ('warehouse','branch','showroom','bin')`),
    check('locations_status_ck', sql`${t.status} in ('active','inactive')`),
    check('locations_parent_ck', sql`${t.parentId} is null or ${t.parentId} <> ${t.id}`),
  ],
);

// ---------------------------------------------------------------- access control

export const roles = pgTable(
  'roles',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    isSystem: boolean('is_system').notNull().default(false),
    permissions: text('permissions')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('roles_tenant_key_uq').on(t.tenantId, t.key),
    unique('roles_tenant_id_uq').on(t.tenantId, t.id),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['active', 'suspended'] })
      .notNull()
      .default('active'),
    /** null = all locations; otherwise restricted to these location ids. */
    locationScope: uuid('location_scope').array(),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('memberships_tenant_user_uq').on(t.tenantId, t.userId),
    unique('memberships_tenant_id_uq').on(t.tenantId, t.id),
    index('memberships_user_idx').on(t.userId),
    check('memberships_status_ck', sql`${t.status} in ('active','suspended')`),
  ],
);

export const membershipRoles = pgTable(
  'membership_roles',
  {
    tenantId: uuid('tenant_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    roleId: uuid('role_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.membershipId, t.roleId] }),
    foreignKey({
      columns: [t.tenantId, t.membershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }).onDelete('cascade'),
    foreignKey({ columns: [t.tenantId, t.roleId], foreignColumns: [roles.tenantId, roles.id] }).onDelete(
      'restrict',
    ),
    index('membership_roles_role_idx').on(t.tenantId, t.roleId),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    roleIds: uuid('role_ids').array().notNull(),
    locationScope: uuid('location_scope').array(),
    tokenHash: text('token_hash').notNull(),
    status: text('status', { enum: ['pending', 'accepted', 'revoked', 'expired'] })
      .notNull()
      .default('pending'),
    expiresAt: ts('expires_at').notNull(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
    acceptedAt: ts('accepted_at'),
    revokedAt: ts('revoked_at'),
    version: version(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('invitations_token_hash_uq').on(t.tokenHash),
    uniqueIndex('invitations_pending_email_uq')
      .on(t.tenantId, t.email)
      .where(sql`${t.status} = 'pending'`),
    check('invitations_status_ck', sql`${t.status} in ('pending','accepted','revoked','expired')`),
    check('invitations_email_lower_ck', sql`${t.email} = lower(${t.email})`),
  ],
);

// ---------------------------------------------------------------- audit, outbox, idempotency

export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'restrict' }),
    actorType: text('actor_type', { enum: ['user', 'platform', 'system'] }).notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    oldValues: jsonb('old_values'),
    newValues: jsonb('new_values'),
    reason: text('reason'),
    correlationId: text('correlation_id'),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_events_tenant_created_idx').on(t.tenantId, t.createdAt.desc(), t.id.desc()),
    index('audit_events_entity_idx').on(t.tenantId, t.entityType, t.entityId),
    check('audit_events_actor_type_ck', sql`${t.actorType} in ('user','platform','system')`),
  ],
);

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'restrict' }),
    eventType: text('event_type').notNull(),
    eventVersion: integer('event_version').notNull().default(1),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    aggregateVersion: integer('aggregate_version').notNull().default(0),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
    correlationId: text('correlation_id'),
    causationId: text('causation_id'),
    payload: jsonb('payload').notNull(),
    status: text('status', { enum: ['pending', 'published', 'dead'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
    lastError: text('last_error'),
    publishedAt: ts('published_at'),
  },
  (t) => [
    index('outbox_events_dispatch_idx').on(t.status, t.nextAttemptAt),
    check('outbox_events_status_ck', sql`${t.status} in ('pending','published','dead')`),
  ],
);

/** Consumer-side dedupe for at-least-once delivery. */
export const processedEvents = pgTable(
  'processed_events',
  {
    consumer: text('consumer').notNull(),
    eventId: uuid('event_id').notNull(),
    processedAt: ts('processed_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.consumer, t.eventId] })],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: id(),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    route: text('route').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status', { enum: ['in_progress', 'completed'] })
      .notNull()
      .default('in_progress'),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [
    uniqueIndex('idempotency_keys_scope_key_uq').on(t.scope, t.key),
    check('idempotency_keys_status_ck', sql`${t.status} in ('in_progress','completed')`),
  ],
);

/** Tables protected by tenant RLS policies (see migration 0001). Kept here so tests can assert coverage. */
export const RLS_TABLES = [
  'tenant_entitlements',
  'stores',
  'channels',
  'channel_domains',
  'locations',
  'roles',
  'memberships',
  'membership_roles',
  'invitations',
  'audit_events',
  'outbox_events',
] as const;
