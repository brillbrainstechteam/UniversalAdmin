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
import { variants } from './catalog-schema';
import { reservations } from './inventory-schema';
import { priceQuotes } from './pricing-schema';
import { channels, tenants, users } from './schema';

// Phase 07 orders, carts, sandbox payments and quotations (ADR-022).
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });
const id = () => uuid('id').primaryKey().defaultRandom();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });
const version = () => integer('version').notNull().default(0);
const minor = (name: string) => bigint(name, { mode: 'bigint' });

export const orderSettings = pgTable(
  'order_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    approvalThresholdMinor: minor('approval_threshold_minor'),
    checkoutHoldMinutes: integer('checkout_hold_minutes').notNull().default(30),
    quotationMaxDays: integer('quotation_max_days').notNull().default(7),
    orderPrefix: text('order_prefix').notNull().default('ORD'),
    quotationPrefix: text('quotation_prefix').notNull().default('QUO'),
    nextOrderNumber: integer('next_order_number').notNull().default(1),
    nextQuotationNumber: integer('next_quotation_number').notNull().default(1),
    rfqPrefix: text('rfq_prefix').notNull().default('RFQ'),
    nextRfqNumber: integer('next_rfq_number').notNull().default(1),
    /** Phase 09: days after delivery (or dispatch) in which a return can be requested. Configurable, not legal advice. */
    returnWindowDays: integer('return_window_days').notNull().default(14),
    returnPrefix: text('return_prefix').notNull().default('RET'),
    nextReturnNumber: integer('next_return_number').notNull().default(1),
    version: version(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('order_settings_hold_ck', sql`${t.checkoutHoldMinutes} between 5 and 1440`),
    check('order_settings_quotation_days_ck', sql`${t.quotationMaxDays} between 1 and 90`),
    check('order_settings_return_days_ck', sql`${t.returnWindowDays} between 0 and 365`),
    check(
      'order_settings_threshold_ck',
      sql`${t.approvalThresholdMinor} is null or ${t.approvalThresholdMinor} >= 0`,
    ),
  ],
);

/** Storefront carts: identified by id + a secret token (only its SHA-256 is stored). */
export const carts = pgTable(
  'carts',
  {
    id: id(),
    tenantId: tenantId(),
    channelId: uuid('channel_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** Phase 10: discount code the shopper entered (re-validated on every quote and at checkout). */
    discountCode: text('discount_code'),
    status: text('status', { enum: ['open', 'converted', 'abandoned'] })
      .notNull()
      .default('open'),
    lines: jsonb('lines').notNull(),
    orderId: uuid('order_id'),
    expiresAt: ts('expires_at').notNull(),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('carts_tenant_id_uq').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.channelId], foreignColumns: [channels.tenantId, channels.id] }),
    check('carts_status_ck', sql`${t.status} in ('open','converted','abandoned')`),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: id(),
    tenantId: tenantId(),
    number: text('number').notNull(),
    channelId: uuid('channel_id'),
    origin: text('origin', { enum: ['storefront', 'admin', 'quotation'] }).notNull(),
    status: text('status', {
      enum: [
        'awaiting_buyer_approval',
        'awaiting_approval',
        'pending_payment',
        'confirmed',
        'on_hold',
        'cancelled',
      ],
    }).notNull(),
    paymentStatus: text('payment_status', {
      enum: ['unpaid', 'pending', 'paid', 'failed', 'refund_due', 'partially_refunded', 'refunded'],
    })
      .notNull()
      .default('unpaid'),
    /** Phase 09 fulfilment progress (shipments). */
    fulfillmentStatus: text('fulfillment_status', { enum: ['unfulfilled', 'partial', 'fulfilled'] })
      .notNull()
      .default('unfulfilled'),
    /** Phase 09: the signed-in storefront customer who placed the order (guest orders stay unlinked). */
    customerId: uuid('customer_id'),
    /** Phase 10: marketing attribution captured at checkout (UTM source/medium/campaign, landing path). */
    attribution: jsonb('attribution'),
    paymentTerms: text('payment_terms', { enum: ['prepaid', 'on_account'] }).notNull(),
    currency: text('currency').notNull(),
    subtotalMinor: minor('subtotal_minor').notNull(),
    discountMinor: minor('discount_minor').notNull(),
    taxMinor: minor('tax_minor').notNull(),
    totalMinor: minor('total_minor').notNull(),
    refundDueMinor: minor('refund_due_minor')
      .notNull()
      .default(sql`0`),
    contact: jsonb('contact').notNull(),
    shippingAddress: jsonb('shipping_address'),
    note: text('note'),
    priceQuoteId: uuid('price_quote_id'),
    quotationId: uuid('quotation_id'),
    cartId: uuid('cart_id'),
    /** Phase 08 B2B: buying company, its delivery location, the buyer and the buyer-side approval. */
    companyId: uuid('company_id'),
    companyLocationId: uuid('company_location_id'),
    buyerId: uuid('buyer_id'),
    poNumber: text('po_number'),
    buyerApprovedBy: uuid('buyer_approved_by').references(() => users.id, { onDelete: 'set null' }),
    buyerApprovedAt: ts('buyer_approved_at'),
    buyerApprovalNote: text('buyer_approval_note'),
    /** Storefront checkout Idempotency-Key: a second order for the same key is impossible (DB backstop). */
    checkoutKey: text('checkout_key'),
    warnings: jsonb('warnings')
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: ts('approved_at'),
    confirmedAt: ts('confirmed_at'),
    cancelledAt: ts('cancelled_at'),
    cancelReason: text('cancel_reason'),
    expiresAt: ts('expires_at'),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('orders_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('orders_tenant_number_uq').on(t.tenantId, t.number),
    uniqueIndex('orders_checkout_key_uq')
      .on(t.tenantId, t.checkoutKey)
      .where(sql`${t.checkoutKey} is not null`),
    index('orders_tenant_created_idx').on(t.tenantId, t.createdAt.desc()),
    index('orders_due_idx').on(t.status, t.expiresAt),
    index('orders_company_idx').on(t.companyId, t.createdAt.desc()),
    index('orders_customer_idx').on(t.customerId, t.createdAt.desc()),
    foreignKey({ columns: [t.tenantId, t.channelId], foreignColumns: [channels.tenantId, channels.id] }),
    foreignKey({
      columns: [t.tenantId, t.priceQuoteId],
      foreignColumns: [priceQuotes.tenantId, priceQuotes.id],
    }),
    check(
      'orders_status_ck',
      sql`${t.status} in ('awaiting_buyer_approval','awaiting_approval','pending_payment','confirmed','on_hold','cancelled')`,
    ),
    check(
      'orders_payment_status_ck',
      sql`${t.paymentStatus} in ('unpaid','pending','paid','failed','refund_due','partially_refunded','refunded')`,
    ),
    check('orders_fulfillment_ck', sql`${t.fulfillmentStatus} in ('unfulfilled','partial','fulfilled')`),
    check('orders_total_ck', sql`${t.totalMinor} = ${t.subtotalMinor} - ${t.discountMinor} + ${t.taxMinor}`),
    check('orders_refund_ck', sql`${t.refundDueMinor} >= 0 and ${t.refundDueMinor} <= ${t.totalMinor}`),
    check('orders_currency_ck', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('orders_cancel_ck', sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`),
  ],
);

/** Immutable order lines with the frozen price snapshot (trigger forbids UPDATE/DELETE). */
export const orderLines = pgTable(
  'order_lines',
  {
    id: id(),
    tenantId: tenantId(),
    orderId: uuid('order_id').notNull(),
    lineNo: integer('line_no').notNull(),
    variantId: uuid('variant_id').notNull(),
    serialItemId: uuid('serial_item_id'),
    sku: text('sku').notNull(),
    title: text('title').notNull(),
    serialTag: text('serial_tag'),
    quantity: integer('quantity').notNull(),
    totalMinor: minor('total_minor').notNull(),
    priceSnapshot: jsonb('price_snapshot').notNull(),
    reservationId: uuid('reservation_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('order_lines_order_line_uq').on(t.orderId, t.lineNo),
    index('order_lines_reservation_idx').on(t.reservationId),
    foreignKey({ columns: [t.tenantId, t.orderId], foreignColumns: [orders.tenantId, orders.id] }).onDelete(
      'cascade',
    ),
    foreignKey({ columns: [t.tenantId, t.variantId], foreignColumns: [variants.tenantId, variants.id] }),
    foreignKey({
      columns: [t.tenantId, t.reservationId],
      foreignColumns: [reservations.tenantId, reservations.id],
    }),
    check('order_lines_quantity_ck', sql`${t.quantity} > 0`),
  ],
);

/** Append-only order timeline. */
export const orderEvents = pgTable(
  'order_events',
  {
    id: id(),
    tenantId: tenantId(),
    orderId: uuid('order_id').notNull(),
    /** Insertion order: several events can share a timestamp inside one transaction. */
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
    type: text('type').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    note: text('note'),
    data: jsonb('data')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('order_events_order_idx').on(t.orderId, t.seq),
    foreignKey({ columns: [t.tenantId, t.orderId], foreignColumns: [orders.tenantId, orders.id] }).onDelete(
      'cascade',
    ),
  ],
);

/** Payment attempts. Only the sandbox provider exists in this build. */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    tenantId: tenantId(),
    orderId: uuid('order_id').notNull(),
    provider: text('provider', { enum: ['sandbox'] }).notNull(),
    status: text('status', { enum: ['pending', 'captured', 'failed'] })
      .notNull()
      .default('pending'),
    amountMinor: minor('amount_minor').notNull(),
    currency: text('currency').notNull(),
    failureReason: text('failure_reason'),
    /** Phase 09: refunds requested or completed against this payment (pending + succeeded). */
    refundedMinor: minor('refunded_minor')
      .notNull()
      .default(sql`0`),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('payments_tenant_id_uq').on(t.tenantId, t.id),
    index('payments_order_idx').on(t.orderId),
    uniqueIndex('payments_one_pending_uq')
      .on(t.orderId)
      .where(sql`${t.status} = 'pending'`),
    foreignKey({ columns: [t.tenantId, t.orderId], foreignColumns: [orders.tenantId, orders.id] }).onDelete(
      'cascade',
    ),
    check('payments_status_ck', sql`${t.status} in ('pending','captured','failed')`),
    check('payments_amount_ck', sql`${t.amountMinor} > 0`),
    check(
      'payments_refunded_ck',
      sql`${t.refundedMinor} >= 0 and ${t.refundedMinor} <= ${t.amountMinor} and (${t.refundedMinor} = 0 or ${t.status} = 'captured')`,
    ),
  ],
);

/** Processed provider callbacks (replay protection). Not tenant-scoped: event IDs are global per provider. */
export const paymentEvents = pgTable(
  'payment_events',
  {
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    outcome: text('outcome').notNull(),
    receivedAt: ts('received_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('payment_events_provider_event_uq').on(t.provider, t.eventId)],
);

export const quotations = pgTable(
  'quotations',
  {
    id: id(),
    tenantId: tenantId(),
    number: text('number').notNull(),
    status: text('status', { enum: ['draft', 'sent', 'accepted', 'converted', 'cancelled', 'expired'] })
      .notNull()
      .default('draft'),
    channelId: uuid('channel_id'),
    contact: jsonb('contact').notNull(),
    notes: text('notes'),
    lines: jsonb('lines').notNull(),
    validUntil: ts('valid_until').notNull(),
    priceQuoteId: uuid('price_quote_id'),
    acceptanceNote: text('acceptance_note'),
    /** Phase 08: quotation for a company, optionally answering an RFQ. */
    companyId: uuid('company_id'),
    rfqId: uuid('rfq_id'),
    orderId: uuid('order_id'),
    cancelReason: text('cancel_reason'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    sentAt: ts('sent_at'),
    acceptedAt: ts('accepted_at'),
    version: version(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('quotations_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('quotations_tenant_number_uq').on(t.tenantId, t.number),
    index('quotations_due_idx').on(t.status, t.validUntil),
    foreignKey({ columns: [t.tenantId, t.channelId], foreignColumns: [channels.tenantId, channels.id] }),
    foreignKey({
      columns: [t.tenantId, t.priceQuoteId],
      foreignColumns: [priceQuotes.tenantId, priceQuotes.id],
    }),
    check(
      'quotations_status_ck',
      sql`${t.status} in ('draft','sent','accepted','converted','cancelled','expired')`,
    ),
    check('quotations_sent_ck', sql`${t.status} in ('draft','cancelled') or ${t.priceQuoteId} is not null`),
  ],
);

export const ORDER_RLS_TABLES = [
  'order_settings',
  'carts',
  'orders',
  'order_lines',
  'order_events',
  'payments',
  'quotations',
] as const;
