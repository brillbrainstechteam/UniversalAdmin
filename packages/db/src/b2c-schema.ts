import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
import { orderLines, orders, payments } from './orders-schema';
import { locations, tenants, users } from './schema';

// Phase 09 B2C retail: storefront customers, consent, fulfilment, returns, refunds, messages (ADR-024).
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });
const id = () => uuid('id').primaryKey().defaultRandom();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });
const version = () => integer('version').notNull().default(0);
const minor = (name: string) => bigint(name, { mode: 'bigint' });

/** A merchant's storefront customer. Not a platform user: the account exists only on this tenant's storefront. */
export const customers = pgTable(
  'customers',
  {
    id: id(),
    tenantId: tenantId(),
    /** Lower-cased. Unverified until an e-mail connector exists (Phase 11). */
    email: text('email').notNull(),
    emailVerifiedAt: ts('email_verified_at'),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    phone: text('phone'),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: ts('locked_until'),
    lastLoginAt: ts('last_login_at'),
    isDemo: boolean('is_demo').notNull().default(false),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('customers_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('customers_tenant_email_uq').on(t.tenantId, t.email),
    index('customers_tenant_created_idx').on(t.tenantId, t.createdAt.desc()),
    check('customers_status_ck', sql`${t.status} in ('active','disabled')`),
    check('customers_email_lower_ck', sql`${t.email} = lower(${t.email})`),
  ],
);

/** Opaque storefront sessions (only the SHA-256 of the token is stored), scoped to one tenant. */
export const customerSessions = pgTable(
  'customer_sessions',
  {
    id: id(),
    tenantId: tenantId(),
    customerId: uuid('customer_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    revokedAt: ts('revoked_at'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [
    uniqueIndex('customer_sessions_token_uq').on(t.tokenHash),
    index('customer_sessions_customer_idx').on(t.customerId),
    foreignKey({
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }).onDelete('cascade'),
  ],
);

export const customerAddresses = pgTable(
  'customer_addresses',
  {
    id: id(),
    tenantId: tenantId(),
    customerId: uuid('customer_id').notNull(),
    label: text('label'),
    address: jsonb('address').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('customer_addresses_customer_idx').on(t.customerId),
    uniqueIndex('customer_addresses_default_uq')
      .on(t.customerId)
      .where(sql`${t.isDefault}`),
    foreignKey({
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }).onDelete('cascade'),
  ],
);

/** Append-only consent log; the current preference is the latest event per channel and purpose. */
export const consentEvents = pgTable(
  'consent_events',
  {
    id: id(),
    tenantId: tenantId(),
    customerId: uuid('customer_id').notNull(),
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
    channel: text('channel', { enum: ['email', 'sms', 'whatsapp'] }).notNull(),
    purpose: text('purpose', { enum: ['marketing'] }).notNull(),
    granted: boolean('granted').notNull(),
    source: text('source', { enum: ['registration', 'account', 'admin'] }).notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    ip: text('ip'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('consent_events_customer_idx').on(t.customerId, t.seq),
    foreignKey({
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }).onDelete('cascade'),
    check('consent_events_channel_ck', sql`${t.channel} in ('email','sms','whatsapp')`),
    check('consent_events_purpose_ck', sql`${t.purpose} in ('marketing')`),
    check('consent_events_source_ck', sql`${t.source} in ('registration','account','admin')`),
  ],
);

export const shipments = pgTable(
  'shipments',
  {
    id: id(),
    tenantId: tenantId(),
    orderId: uuid('order_id').notNull(),
    number: text('number').notNull(),
    status: text('status', { enum: ['packed', 'shipped', 'delivered', 'cancelled'] })
      .notNull()
      .default('packed'),
    /** Typed by staff; no courier API is connected, so nothing is tracked automatically. */
    carrier: text('carrier'),
    trackingNumber: text('tracking_number'),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    shippedAt: ts('shipped_at'),
    deliveredAt: ts('delivered_at'),
    cancelledAt: ts('cancelled_at'),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('shipments_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('shipments_tenant_number_uq').on(t.tenantId, t.number),
    index('shipments_order_idx').on(t.orderId),
    foreignKey({ columns: [t.tenantId, t.orderId], foreignColumns: [orders.tenantId, orders.id] }),
    check('shipments_status_ck', sql`${t.status} in ('packed','shipped','delivered','cancelled')`),
    check(
      'shipments_shipped_ck',
      sql`${t.status} not in ('shipped','delivered') or ${t.shippedAt} is not null`,
    ),
  ],
);

export const shipmentLines = pgTable(
  'shipment_lines',
  {
    id: id(),
    tenantId: tenantId(),
    shipmentId: uuid('shipment_id').notNull(),
    orderLineId: uuid('order_line_id')
      .notNull()
      .references(() => orderLines.id),
    quantity: integer('quantity').notNull(),
  },
  (t) => [
    uniqueIndex('shipment_lines_uq').on(t.shipmentId, t.orderLineId),
    index('shipment_lines_order_line_idx').on(t.orderLineId),
    foreignKey({
      columns: [t.tenantId, t.shipmentId],
      foreignColumns: [shipments.tenantId, shipments.id],
    }).onDelete('cascade'),
    check('shipment_lines_qty_ck', sql`${t.quantity} > 0`),
  ],
);

export const returns = pgTable(
  'returns',
  {
    id: id(),
    tenantId: tenantId(),
    number: text('number').notNull(),
    orderId: uuid('order_id').notNull(),
    customerId: uuid('customer_id'),
    status: text('status', { enum: ['requested', 'approved', 'rejected', 'received'] })
      .notNull()
      .default('requested'),
    reason: text('reason').notNull(),
    requestedBy: text('requested_by', { enum: ['customer', 'staff'] }).notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: ts('decided_at'),
    decisionNote: text('decision_note'),
    receivedBy: uuid('received_by').references(() => users.id, { onDelete: 'set null' }),
    receivedAt: ts('received_at'),
    restocked: boolean('restocked'),
    receiveLocationId: uuid('receive_location_id'),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('returns_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('returns_tenant_number_uq').on(t.tenantId, t.number),
    index('returns_order_idx').on(t.orderId),
    index('returns_tenant_created_idx').on(t.tenantId, t.createdAt.desc()),
    foreignKey({ columns: [t.tenantId, t.orderId], foreignColumns: [orders.tenantId, orders.id] }),
    foreignKey({ columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    foreignKey({
      columns: [t.tenantId, t.receiveLocationId],
      foreignColumns: [locations.tenantId, locations.id],
    }),
    check('returns_status_ck', sql`${t.status} in ('requested','approved','rejected','received')`),
    check('returns_received_ck', sql`(${t.status} = 'received') = (${t.receivedAt} is not null)`),
  ],
);

export const returnLines = pgTable(
  'return_lines',
  {
    id: id(),
    tenantId: tenantId(),
    returnId: uuid('return_id').notNull(),
    orderLineId: uuid('order_line_id')
      .notNull()
      .references(() => orderLines.id),
    quantity: integer('quantity').notNull(),
    /** Value of the returned units from the frozen order line (exact split by quantity). */
    valueMinor: minor('value_minor').notNull(),
  },
  (t) => [
    uniqueIndex('return_lines_uq').on(t.returnId, t.orderLineId),
    index('return_lines_order_line_idx').on(t.orderLineId),
    foreignKey({
      columns: [t.tenantId, t.returnId],
      foreignColumns: [returns.tenantId, returns.id],
    }).onDelete('cascade'),
    check('return_lines_qty_ck', sql`${t.quantity} > 0`),
    check('return_lines_value_ck', sql`${t.valueMinor} >= 0`),
  ],
);

/** Refunds against a captured payment. Only the sandbox gateway exists in this build. */
export const refunds = pgTable(
  'refunds',
  {
    id: id(),
    tenantId: tenantId(),
    orderId: uuid('order_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    returnId: uuid('return_id'),
    provider: text('provider', { enum: ['sandbox'] }).notNull(),
    status: text('status', { enum: ['pending', 'succeeded', 'failed'] })
      .notNull()
      .default('pending'),
    amountMinor: minor('amount_minor').notNull(),
    currency: text('currency').notNull(),
    reason: text('reason').notNull(),
    failureReason: text('failure_reason'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    idempotencyKey: text('idempotency_key').notNull(),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('refunds_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('refunds_idempotency_uq').on(t.tenantId, t.idempotencyKey),
    index('refunds_order_idx').on(t.orderId),
    foreignKey({ columns: [t.tenantId, t.orderId], foreignColumns: [orders.tenantId, orders.id] }),
    foreignKey({ columns: [t.tenantId, t.paymentId], foreignColumns: [payments.tenantId, payments.id] }),
    foreignKey({ columns: [t.tenantId, t.returnId], foreignColumns: [returns.tenantId, returns.id] }),
    check('refunds_status_ck', sql`${t.status} in ('pending','succeeded','failed')`),
    check('refunds_amount_ck', sql`${t.amountMinor} > 0`),
  ],
);

/**
 * Transactional customer messages. Recorded with status `not_sent` until a notification connector exists
 * (Phase 11): nothing here claims delivery.
 */
export const customerMessages = pgTable(
  'customer_messages',
  {
    id: id(),
    tenantId: tenantId(),
    orderId: uuid('order_id'),
    customerId: uuid('customer_id'),
    recipient: text('recipient').notNull(),
    channel: text('channel', { enum: ['email'] }).notNull(),
    template: text('template').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    status: text('status', { enum: ['not_sent', 'sent', 'failed'] })
      .notNull()
      .default('not_sent'),
    statusReason: text('status_reason'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('customer_messages_order_idx').on(t.orderId, t.createdAt),
    index('customer_messages_customer_idx').on(t.customerId, t.createdAt.desc()),
    foreignKey({ columns: [t.tenantId, t.orderId], foreignColumns: [orders.tenantId, orders.id] }),
    foreignKey({ columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    check('customer_messages_status_ck', sql`${t.status} in ('not_sent','sent','failed')`),
  ],
);

export const B2C_RLS_TABLES = [
  'customers',
  'customer_sessions',
  'customer_addresses',
  'consent_events',
  'shipments',
  'shipment_lines',
  'returns',
  'return_lines',
  'refunds',
  'customer_messages',
] as const;
