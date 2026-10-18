import { sql } from 'drizzle-orm';
import {
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
import { serialItems } from './jewellery-schema';
import { channels, locations, tenants, users } from './schema';

// Phase 04 inventory. Quantities are NUMERIC(20,6) (pcs are validated as integers; grams allow decimals).
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });
const id = () => uuid('id').primaryKey().defaultRandom();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });
const qty = (name: string) => numeric(name, { precision: 20, scale: 6 });
const version = () => integer('version').notNull().default(0);

export const STOCK_CONDITIONS = ['sellable', 'damaged', 'quarantine', 'in_transit'] as const;
export const MOVEMENT_TYPES = [
  'receipt',
  'adjustment',
  'condition_change',
  'transfer_dispatch',
  'transfer_receive',
  'transfer_cancel',
  'stocktake',
  'reservation_hold',
  'reservation_release',
  'reservation_expire',
  'reservation_commit',
  'commitment_release',
  'write_off',
] as const;

export const stockSettings = pgTable(
  'stock_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    defaultBuffer: qty('default_buffer').notNull().default('0'),
    reservationTtlMinutes: integer('reservation_ttl_minutes').notNull().default(15),
    lowStockThreshold: qty('low_stock_threshold').notNull().default('1'),
    backorderPolicy: text('backorder_policy', { enum: ['disabled'] })
      .notNull()
      .default('disabled'),
    version: version(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('stock_settings_buffer_ck', sql`${t.defaultBuffer} >= 0`),
    check('stock_settings_ttl_ck', sql`${t.reservationTtlMinutes} between 1 and 10080`),
  ],
);

export const variantStockSettings = pgTable(
  'variant_stock_settings',
  {
    tenantId: tenantId(),
    variantId: uuid('variant_id').notNull(),
    tracking: text('tracking', { enum: ['quantity', 'serial'] })
      .notNull()
      .default('quantity'),
    unit: text('unit', { enum: ['pcs', 'g'] })
      .notNull()
      .default('pcs'),
    buffer: qty('buffer'),
    lowStockThreshold: qty('low_stock_threshold'),
    version: version(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.variantId] }),
    foreignKey({
      columns: [t.tenantId, t.variantId],
      foreignColumns: [variants.tenantId, variants.id],
    }).onDelete('cascade'),
    check('variant_stock_settings_buffer_ck', sql`${t.buffer} is null or ${t.buffer} >= 0`),
    check('variant_stock_settings_serial_pcs_ck', sql`${t.tracking} <> 'serial' or ${t.unit} = 'pcs'`),
  ],
);

export const channelStockLocations = pgTable(
  'channel_stock_locations',
  {
    tenantId: tenantId(),
    channelId: uuid('channel_id').notNull(),
    locationId: uuid('location_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.locationId] }),
    foreignKey({
      columns: [t.tenantId, t.channelId],
      foreignColumns: [channels.tenantId, channels.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.locationId],
      foreignColumns: [locations.tenantId, locations.id],
    }).onDelete('cascade'),
  ],
);

export const stockBalances = pgTable(
  'stock_balances',
  {
    id: id(),
    tenantId: tenantId(),
    variantId: uuid('variant_id').notNull(),
    locationId: uuid('location_id').notNull(),
    condition: text('condition', { enum: STOCK_CONDITIONS }).notNull(),
    onHand: qty('on_hand').notNull().default('0'),
    reserved: qty('reserved').notNull().default('0'),
    committed: qty('committed').notNull().default('0'),
    version: version(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('stock_balances_key_uq').on(t.tenantId, t.variantId, t.locationId, t.condition),
    index('stock_balances_location_idx').on(t.tenantId, t.locationId),
    foreignKey({
      columns: [t.tenantId, t.variantId],
      foreignColumns: [variants.tenantId, variants.id],
    }).onDelete('cascade'),
    foreignKey({ columns: [t.tenantId, t.locationId], foreignColumns: [locations.tenantId, locations.id] }),
    check(
      'stock_balances_condition_ck',
      sql`${t.condition} in ('sellable','damaged','quarantine','in_transit')`,
    ),
    // No negative stock and no oversell, enforced by the database itself (backorders disabled, OD-6).
    check('stock_balances_nonneg_ck', sql`${t.onHand} >= 0 and ${t.reserved} >= 0 and ${t.committed} >= 0`),
    check('stock_balances_cover_ck', sql`${t.onHand} >= ${t.reserved} + ${t.committed}`),
    check(
      'stock_balances_holds_sellable_ck',
      sql`${t.condition} = 'sellable' or (${t.reserved} = 0 and ${t.committed} = 0)`,
    ),
  ],
);

export const stockMovements = pgTable(
  'stock_movements',
  {
    id: id(),
    tenantId: tenantId(),
    variantId: uuid('variant_id').notNull(),
    locationId: uuid('location_id').notNull(),
    condition: text('condition', { enum: STOCK_CONDITIONS }).notNull(),
    serialItemId: uuid('serial_item_id'),
    type: text('type', { enum: MOVEMENT_TYPES }).notNull(),
    onHandDelta: qty('on_hand_delta').notNull().default('0'),
    reservedDelta: qty('reserved_delta').notNull().default('0'),
    committedDelta: qty('committed_delta').notNull().default('0'),
    reasonCode: text('reason_code'),
    note: text('note'),
    /** External document number (GRN, count sheet…), see stock_documents. */
    reference: text('reference'),
    /** Groups the rows of one business operation (transfer, condition change, count, reservation). */
    operationId: uuid('operation_id').notNull(),
    reservationId: uuid('reservation_id'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
  },
  (t) => [
    index('stock_movements_variant_idx').on(t.tenantId, t.variantId, t.occurredAt.desc()),
    index('stock_movements_operation_idx').on(t.tenantId, t.operationId),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
    foreignKey({ columns: [t.tenantId, t.locationId], foreignColumns: [locations.tenantId, locations.id] }),
    foreignKey({
      columns: [t.tenantId, t.serialItemId],
      foreignColumns: [serialItems.tenantId, serialItems.id],
    }),
    check(
      'stock_movements_type_ck',
      sql`${t.type} in ('receipt','adjustment','condition_change','transfer_dispatch','transfer_receive','transfer_cancel','stocktake','reservation_hold','reservation_release','reservation_expire','reservation_commit','commitment_release','write_off')`,
    ),
    check(
      'stock_movements_nonzero_ck',
      sql`${t.onHandDelta} <> 0 or ${t.reservedDelta} <> 0 or ${t.committedDelta} <> 0`,
    ),
  ],
);

/**
 * One row per posted stock operation. The (type, reference) pair is unique, so a supplier receipt, count sheet or
 * adjustment voucher can never be posted twice (no double counting), whatever its number of lines or pieces.
 */
export const stockDocuments = pgTable(
  'stock_documents',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    type: text('type', { enum: MOVEMENT_TYPES }).notNull(),
    reference: text('reference'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('stock_documents_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('stock_documents_reference_uq')
      .on(t.tenantId, t.type, t.reference)
      .where(sql`${t.reference} is not null`),
  ],
);

export const reservations = pgTable(
  'reservations',
  {
    id: id(),
    tenantId: tenantId(),
    variantId: uuid('variant_id').notNull(),
    locationId: uuid('location_id').notNull(),
    serialItemId: uuid('serial_item_id'),
    channelId: uuid('channel_id'),
    quantity: qty('quantity').notNull(),
    status: text('status', { enum: ['held', 'committed', 'released', 'expired'] })
      .notNull()
      .default('held'),
    referenceType: text('reference_type', {
      enum: ['manual', 'cart', 'checkout', 'order', 'quote'],
    }).notNull(),
    referenceId: text('reference_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    expiresAt: ts('expires_at'),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    closedReason: text('closed_reason'),
    closedAt: ts('closed_at'),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('reservations_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('reservations_idempotency_uq').on(t.tenantId, t.idempotencyKey),
    index('reservations_due_idx').on(t.status, t.expiresAt),
    index('reservations_variant_idx').on(t.tenantId, t.variantId, t.status),
    // A piece can only be held/committed once at a time.
    uniqueIndex('reservations_serial_active_uq')
      .on(t.tenantId, t.serialItemId)
      .where(sql`${t.serialItemId} is not null and ${t.status} in ('held','committed')`),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
    foreignKey({ columns: [t.tenantId, t.locationId], foreignColumns: [locations.tenantId, locations.id] }),
    foreignKey({
      columns: [t.tenantId, t.serialItemId],
      foreignColumns: [serialItems.tenantId, serialItems.id],
    }),
    check('reservations_status_ck', sql`${t.status} in ('held','committed','released','expired')`),
    check('reservations_qty_ck', sql`${t.quantity} > 0`),
    check('reservations_hold_expiry_ck', sql`${t.status} <> 'held' or ${t.expiresAt} is not null`),
  ],
);

export const transfers = pgTable(
  'transfers',
  {
    id: id(),
    tenantId: tenantId(),
    number: text('number').notNull(),
    fromLocationId: uuid('from_location_id').notNull(),
    toLocationId: uuid('to_location_id').notNull(),
    status: text('status', { enum: ['in_transit', 'received', 'cancelled'] })
      .notNull()
      .default('in_transit'),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    receivedBy: uuid('received_by').references(() => users.id, { onDelete: 'set null' }),
    receivedAt: ts('received_at'),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('transfers_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('transfers_number_uq').on(t.tenantId, t.number),
    foreignKey({
      columns: [t.tenantId, t.fromLocationId],
      foreignColumns: [locations.tenantId, locations.id],
    }),
    foreignKey({ columns: [t.tenantId, t.toLocationId], foreignColumns: [locations.tenantId, locations.id] }),
    check('transfers_distinct_ck', sql`${t.fromLocationId} <> ${t.toLocationId}`),
    check('transfers_status_ck', sql`${t.status} in ('in_transit','received','cancelled')`),
  ],
);

export const transferLines = pgTable(
  'transfer_lines',
  {
    id: id(),
    tenantId: tenantId(),
    transferId: uuid('transfer_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    serialItemId: uuid('serial_item_id'),
    quantity: qty('quantity').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.transferId],
      foreignColumns: [transfers.tenantId, transfers.id],
    }).onDelete('cascade'),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
    foreignKey({
      columns: [t.tenantId, t.serialItemId],
      foreignColumns: [serialItems.tenantId, serialItems.id],
    }),
    check('transfer_lines_qty_ck', sql`${t.quantity} > 0`),
  ],
);

export const stockCounts = pgTable(
  'stock_counts',
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid('location_id').notNull(),
    source: text('source', { enum: ['stocktake', 'import', 'erp'] })
      .notNull()
      .default('stocktake'),
    sourceVersion: text('source_version'),
    asOf: ts('as_of').notNull(),
    status: text('status', { enum: ['applied', 'rejected_stale'] }).notNull(),
    reference: text('reference'),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('stock_counts_tenant_id_uq').on(t.tenantId, t.id),
    index('stock_counts_location_idx').on(t.tenantId, t.locationId, t.source, t.asOf.desc()),
    foreignKey({ columns: [t.tenantId, t.locationId], foreignColumns: [locations.tenantId, locations.id] }),
    check('stock_counts_status_ck', sql`${t.status} in ('applied','rejected_stale')`),
  ],
);

export const stockCountLines = pgTable(
  'stock_count_lines',
  {
    id: id(),
    tenantId: tenantId(),
    countId: uuid('count_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    counted: qty('counted').notNull(),
    expected: qty('expected').notNull(),
    variance: qty('variance').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.countId],
      foreignColumns: [stockCounts.tenantId, stockCounts.id],
    }).onDelete('cascade'),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
    check('stock_count_lines_counted_ck', sql`${t.counted} >= 0`),
  ],
);

export const reconciliationIssues = pgTable(
  'reconciliation_issues',
  {
    id: id(),
    tenantId: tenantId(),
    domain: text('domain', { enum: ['inventory'] })
      .notNull()
      .default('inventory'),
    kind: text('kind', {
      enum: ['ledger_balance_mismatch', 'stale_snapshot', 'stocktake_variance', 'serial_state_mismatch'],
    }).notNull(),
    severity: text('severity', { enum: ['info', 'warning', 'critical'] }).notNull(),
    variantId: uuid('variant_id'),
    locationId: uuid('location_id'),
    details: jsonb('details').notNull(),
    status: text('status', { enum: ['open', 'resolved'] })
      .notNull()
      .default('open'),
    /** Stable key so an unresolved problem is reported once, not on every check. */
    dedupeKey: text('dedupe_key').notNull(),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolutionNote: text('resolution_note'),
    resolvedAt: ts('resolved_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('reconciliation_issues_open_uq')
      .on(t.tenantId, t.dedupeKey)
      .where(sql`${t.status} = 'open'`),
    index('reconciliation_issues_status_idx').on(t.tenantId, t.status, t.createdAt.desc()),
    check('reconciliation_issues_status_ck', sql`${t.status} in ('open','resolved')`),
  ],
);

export const INVENTORY_RLS_TABLES = [
  'stock_settings',
  'variant_stock_settings',
  'channel_stock_locations',
  'stock_balances',
  'stock_movements',
  'stock_documents',
  'reservations',
  'transfers',
  'transfer_lines',
  'stock_counts',
  'stock_count_lines',
  'reconciliation_issues',
] as const;
