import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tenants, users } from './schema';

// Phase 12 launch: plans with usage limits and just-in-time support access (ADR-027).
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });

/**
 * Platform plans (global). Limits are hard for products, staff seats, locations and domains and soft for orders per
 * month (warning only — a sale is never refused for plan reasons). `null` = unlimited. No price: billing is blocked.
 */
export const plans = pgTable(
  'plans',
  {
    key: text('key').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    limits: jsonb('limits').notNull(),
    status: text('status', { enum: ['active', 'retired'] })
      .notNull()
      .default('active'),
    version: integer('version').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('plans_key_ck', sql`${t.key} ~ '^[a-z][a-z0-9_]{1,39}$'`),
    check('plans_status_ck', sql`${t.status} in ('active','retired')`),
  ],
);

/** A platform operator's time-limited, merchant-approved, read-only access to one tenant. */
export const supportGrants = pgTable(
  'support_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    ticketRef: text('ticket_ref'),
    durationMinutes: integer('duration_minutes').notNull(),
    status: text('status', { enum: ['requested', 'approved', 'denied', 'revoked'] })
      .notNull()
      .default('requested'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: ts('decided_at'),
    decisionNote: text('decision_note'),
    /** Set on approval: approval time + duration. */
    expiresAt: ts('expires_at'),
    startedAt: ts('started_at'),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: ts('revoked_at'),
    version: integer('version').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('support_grants_tenant_id_uq').on(t.tenantId, t.id),
    index('support_grants_tenant_idx').on(t.tenantId, t.createdAt.desc()),
    check('support_grants_status_ck', sql`${t.status} in ('requested','approved','denied','revoked')`),
    check('support_grants_duration_ck', sql`${t.durationMinutes} between 15 and 120`),
    check('support_grants_approved_ck', sql`${t.status} <> 'approved' or ${t.expiresAt} is not null`),
  ],
);

export const LAUNCH_RLS_TABLES = ['support_grants'] as const;
export const LAUNCH_GLOBAL_TABLES = ['plans'] as const;
