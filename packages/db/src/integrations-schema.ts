import { sql } from 'drizzle-orm';
import {
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
import { tenants, users } from './schema';

// Phase 05 connector framework (ADR-019).
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });
const id = () => uuid('id').primaryKey().defaultRandom();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });
const version = () => integer('version').notNull().default(0);

export const connections = pgTable(
  'connections',
  {
    id: id(),
    tenantId: tenantId(),
    connectorKey: text('connector_key').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'paused', 'disconnected'] })
      .notNull()
      .default('active'),
    /** Reference into a secret store (vault:/env:/secretsmanager:) — never the secret itself. */
    credentialRef: text('credential_ref'),
    settings: jsonb('settings').notNull(),
    ownership: jsonb('ownership').notNull(),
    /** Adapter-private state (e.g. the simulator's tick and received orders). */
    adapterState: jsonb('adapter_state')
      .notNull()
      .default(sql`'{}'::jsonb`),
    activeMappingVersion: integer('active_mapping_version'),
    lastSyncAt: ts('last_sync_at'),
    lastSuccessAt: ts('last_success_at'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('connections_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('connections_tenant_name_uq').on(t.tenantId, sql`lower(${t.name})`),
    check('connections_status_ck', sql`${t.status} in ('active','paused','disconnected')`),
    check(
      'connections_credential_ref_ck',
      sql`${t.credentialRef} is null or ${t.credentialRef} ~ '^(vault|env|secretsmanager):'`,
    ),
  ],
);

export const fieldMappings = pgTable(
  'field_mappings',
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id').notNull(),
    version: integer('version').notNull(),
    rules: jsonb('rules').notNull(),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('field_mappings_version_uq').on(t.connectionId, t.version),
    foreignKey({
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [connections.tenantId, connections.id],
    }).onDelete('cascade'),
  ],
);

export const syncJobs = pgTable(
  'sync_jobs',
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id').notNull(),
    source: text('source', { enum: ['file', 'simulator'] }).notNull(),
    status: text('status', {
      enum: ['previewed', 'committed', 'partially_committed', 'discarded', 'failed'],
    }).notNull(),
    mappingVersion: integer('mapping_version').notNull(),
    fileName: text('file_name'),
    fileSha256: text('file_sha256'),
    cursorFrom: text('cursor_from'),
    cursorTo: text('cursor_to'),
    snapshotAsOf: ts('snapshot_as_of').notNull(),
    counts: jsonb('counts').notNull(),
    stockResult: jsonb('stock_result'),
    error: text('error'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    committedAt: ts('committed_at'),
  },
  (t) => [
    unique('sync_jobs_tenant_id_uq').on(t.tenantId, t.id),
    index('sync_jobs_connection_idx').on(t.tenantId, t.connectionId, t.createdAt.desc()),
    foreignKey({
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [connections.tenantId, connections.id],
    }).onDelete('cascade'),
    check(
      'sync_jobs_status_ck',
      sql`${t.status} in ('previewed','committed','partially_committed','discarded','failed')`,
    ),
  ],
);

export const syncJobRows = pgTable(
  'sync_job_rows',
  {
    id: id(),
    tenantId: tenantId(),
    jobId: uuid('job_id').notNull(),
    rowNo: integer('row_no').notNull(),
    externalId: text('external_id'),
    action: text('action', { enum: ['create', 'update', 'unchanged', 'stale', 'delete', 'error'] }).notNull(),
    applied: text('applied', { enum: ['no', 'yes'] })
      .notNull()
      .default('no'),
    errors: jsonb('errors').notNull(),
    raw: jsonb('raw').notNull(),
    record: jsonb('record'),
    checksum: text('checksum'),
  },
  (t) => [
    uniqueIndex('sync_job_rows_row_uq').on(t.jobId, t.rowNo),
    index('sync_job_rows_action_idx').on(t.jobId, t.action),
    foreignKey({ columns: [t.tenantId, t.jobId], foreignColumns: [syncJobs.tenantId, syncJobs.id] }).onDelete(
      'cascade',
    ),
  ],
);

/** Dedupe map: one row per (connection, record type, external id) → commerce entity. */
export const externalRecords = pgTable(
  'external_records',
  {
    tenantId: tenantId(),
    connectionId: uuid('connection_id').notNull(),
    recordType: text('record_type', { enum: ['design', 'piece'] }).notNull(),
    externalId: text('external_id').notNull(),
    internalType: text('internal_type', { enum: ['variant', 'serial_item'] }).notNull(),
    internalId: uuid('internal_id').notNull(),
    externalVersion: text('external_version'),
    sourceTimestamp: ts('source_timestamp'),
    checksum: text('checksum').notNull(),
    lastJobId: uuid('last_job_id'),
    /** Last snapshot quantity per location code (designs), used by reconciliation. */
    lastStock: jsonb('last_stock'),
    deletedAt: ts('deleted_at'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.connectionId, t.recordType, t.externalId] }),
    uniqueIndex('external_records_internal_uq').on(t.connectionId, t.internalType, t.internalId),
    index('external_records_internal_idx').on(t.tenantId, t.internalType, t.internalId),
    foreignKey({
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [connections.tenantId, connections.id],
    }).onDelete('cascade'),
  ],
);

export const syncCheckpoints = pgTable(
  'sync_checkpoints',
  {
    tenantId: tenantId(),
    connectionId: uuid('connection_id').notNull(),
    stream: text('stream').notNull(),
    cursor: text('cursor').notNull(),
    sourceTimestamp: ts('source_timestamp'),
    jobId: uuid('job_id'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.connectionId, t.stream] }),
    foreignKey({
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [connections.tenantId, connections.id],
    }).onDelete('cascade'),
  ],
);

export const outboundCommands = pgTable(
  'outbound_commands',
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id').notNull(),
    kind: text('kind', { enum: ['push_order'] }).notNull(),
    /** Stable idempotency reference sent to the ERP; unique per connection. */
    reference: text('reference').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status', { enum: ['pending', 'acknowledged', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at'),
    lastError: text('last_error'),
    externalRef: text('external_ref'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    acknowledgedAt: ts('acknowledged_at'),
  },
  (t) => [
    unique('outbound_commands_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('outbound_commands_reference_uq').on(t.connectionId, t.reference),
    index('outbound_commands_due_idx').on(t.status, t.nextAttemptAt),
    foreignKey({
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [connections.tenantId, connections.id],
    }).onDelete('cascade'),
    check('outbound_commands_status_ck', sql`${t.status} in ('pending','acknowledged','failed')`),
  ],
);

/** Vendor discovery checklist per tenant and connector (specs/05 qualification fields). */
export const connectorDiscovery = pgTable(
  'connector_discovery',
  {
    tenantId: tenantId(),
    connectorKey: text('connector_key').notNull(),
    status: text('status', {
      enum: ['not_started', 'requested', 'docs_received', 'sandbox_ready', 'pilot_passed'],
    })
      .notNull()
      .default('not_started'),
    answers: jsonb('answers').notNull(),
    notes: text('notes'),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    version: version(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.connectorKey] })],
);

export const INTEGRATION_RLS_TABLES = [
  'connections',
  'field_mappings',
  'sync_jobs',
  'sync_job_rows',
  'external_records',
  'sync_checkpoints',
  'outbound_commands',
  'connector_discovery',
] as const;
