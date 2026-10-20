import { sql } from 'drizzle-orm';
import {
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
import { tenants, users } from './schema';

// Phase 11 operations: webhooks, automations, staff notifications, API keys, MFA (ADR-026).
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });
const id = () => uuid('id').primaryKey().defaultRandom();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });
const version = () => integer('version').notNull().default(0);

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    eventTypes: text('event_types').array().notNull(),
    /** AES-256-GCM sealed signing secret (see secrets.ts). */
    secretSealed: text('secret_sealed').notNull(),
    secretHint: text('secret_hint').notNull(),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastSuccessAt: ts('last_success_at'),
    lastFailureAt: ts('last_failure_at'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('webhook_endpoints_tenant_id_uq').on(t.tenantId, t.id),
    check('webhook_endpoints_status_ck', sql`${t.status} in ('active','disabled')`),
    check('webhook_endpoints_url_ck', sql`${t.url} ~ '^https?://'`),
  ],
);

/** One delivery of one event to one endpoint; retried with backoff until delivered or dead. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    tenantId: tenantId(),
    endpointId: uuid('endpoint_id').notNull(),
    eventId: uuid('event_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    source: text('source', { enum: ['event', 'automation', 'test'] })
      .notNull()
      .default('event'),
    status: text('status', { enum: ['pending', 'delivered', 'failed', 'dead'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    deliveredAt: ts('delivered_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('webhook_deliveries_uq').on(t.endpointId, t.eventId, t.source),
    index('webhook_deliveries_due_idx').on(t.status, t.nextAttemptAt),
    index('webhook_deliveries_endpoint_idx').on(t.endpointId, t.createdAt.desc()),
    foreignKey({
      columns: [t.tenantId, t.endpointId],
      foreignColumns: [webhookEndpoints.tenantId, webhookEndpoints.id],
    }).onDelete('cascade'),
    check('webhook_deliveries_status_ck', sql`${t.status} in ('pending','delivered','failed','dead')`),
  ],
);

export const automations = pgTable(
  'automations',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    trigger: text('trigger').notNull(),
    conditions: jsonb('conditions').notNull(),
    action: jsonb('action').notNull(),
    status: text('status', { enum: ['active', 'paused'] })
      .notNull()
      .default('active'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('automations_tenant_id_uq').on(t.tenantId, t.id),
    index('automations_trigger_idx').on(t.tenantId, t.trigger),
    check('automations_status_ck', sql`${t.status} in ('active','paused')`),
  ],
);

export const automationRuns = pgTable(
  'automation_runs',
  {
    id: id(),
    tenantId: tenantId(),
    automationId: uuid('automation_id').notNull(),
    eventId: uuid('event_id').notNull(),
    outcome: text('outcome', { enum: ['done', 'skipped', 'failed'] }).notNull(),
    detail: text('detail'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('automation_runs_uq').on(t.automationId, t.eventId),
    index('automation_runs_automation_idx').on(t.automationId, t.createdAt.desc()),
    foreignKey({
      columns: [t.tenantId, t.automationId],
      foreignColumns: [automations.tenantId, automations.id],
    }).onDelete('cascade'),
    check('automation_runs_outcome_ck', sql`${t.outcome} in ('done','skipped','failed')`),
  ],
);

/** In-app staff inbox (tenant-wide or for one user). */
export const staffNotifications = pgTable(
  'staff_notifications',
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    source: text('source').notNull(),
    readBy: uuid('read_by')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('staff_notifications_tenant_idx').on(t.tenantId, t.createdAt.desc())],
);

/** Read-only API keys: act for their creator, limited to `scopes`. Only the SHA-256 of the key is stored. */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: ts('expires_at'),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('api_keys_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('api_keys_hash_uq').on(t.keyHash),
    check('api_keys_scopes_ck', sql`cardinality(${t.scopes}) > 0`),
  ],
);

/** TOTP factor of a user (global: users are global). Seed sealed with AES-256-GCM. */
export const mfaFactors = pgTable('mfa_factors', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  secretSealed: text('secret_sealed').notNull(),
  confirmedAt: ts('confirmed_at'),
  /** Last accepted 30-second step: a code can be used once. */
  lastStep: integer('last_step'),
  /** SHA-256 hashes of unused recovery codes. */
  recoveryHashes: text('recovery_hashes')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Pending second step of a sign-in (5 minutes, 5 attempts). */
export const mfaChallenges = pgTable(
  'mfa_challenges',
  {
    id: id(),
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    audience: text('audience').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('mfa_challenges_token_uq').on(t.tokenHash)],
);

export const OPS_RLS_TABLES = [
  'webhook_endpoints',
  'webhook_deliveries',
  'automations',
  'automation_runs',
  'staff_notifications',
  'api_keys',
] as const;
/** Global (user-level) tables, accessed through system transactions only. */
export const OPS_GLOBAL_TABLES = ['mfa_factors', 'mfa_challenges'] as const;
