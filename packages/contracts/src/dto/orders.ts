import { CurrencyCode, Email, PageQuery, Reason, Timestamp, Uuid, Version, pageOf } from '../common';
import { z } from '../z';
import { Address } from './admin';
import { CustomerMessage, FulfillmentStatus, OrderReturn, Refund, Shipment } from './fulfillment';
import { ActorRef } from './inventory';
import { PriceQuote, QuoteLine, QuoteLineInput, StorefrontQuote } from './pricing';

/**
 * Phase 07 orders, carts, checkout, sandbox payments and sales quotations. Totals are always server-calculated
 * integer minor units; a client only ever *acknowledges* a total it was shown.
 */
const MinorAmount = z.string().regex(/^\d{1,18}$/, 'Whole minor units').openapi({ description: 'Integer minor units (string)' });

export const Contact = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: Email,
    phone: z.string().trim().max(30).nullable().optional(),
  })
  .openapi('Contact');
export type Contact = z.infer<typeof Contact>;

export const ORDER_STATUSES = ['awaiting_buyer_approval', 'awaiting_approval', 'pending_payment', 'confirmed', 'on_hold', 'cancelled'] as const;
export const OrderStatus = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof OrderStatus>;
export const PaymentStatus = z.enum(['unpaid', 'pending', 'paid', 'failed', 'refund_due', 'partially_refunded', 'refunded']);
export type PaymentStatus = z.infer<typeof PaymentStatus>;
export const PaymentTerms = z.enum(['prepaid', 'on_account']);

// ---------------------------------------------------------------- settings

export const OrderSettings = z
  .object({
    /** Admin orders with a total at or above this need a second person's approval (null = never). */
    approvalThresholdMinor: MinorAmount.nullable(),
    checkoutHoldMinutes: z.number().int(),
    quotationMaxDays: z.number().int(),
    orderPrefix: z.string(),
    quotationPrefix: z.string(),
    /** Days after delivery (or dispatch) a return can be requested. A business setting, not legal advice. */
    returnWindowDays: z.number().int(),
    version: Version,
    updatedAt: Timestamp,
  })
  .openapi('OrderSettings');
export type OrderSettings = z.infer<typeof OrderSettings>;
const Prefix = z.string().trim().regex(/^[A-Z][A-Z0-9-]{0,9}$/, 'Upper-case letters, digits, hyphen (max 10)');
export const UpdateOrderSettingsRequest = z
  .object({
    version: Version,
    approvalThresholdMinor: MinorAmount.nullable().optional(),
    checkoutHoldMinutes: z.number().int().min(5).max(24 * 60).optional(),
    quotationMaxDays: z.number().int().min(1).max(90).optional(),
    orderPrefix: Prefix.optional(),
    quotationPrefix: Prefix.optional(),
    returnWindowDays: z.number().int().min(0).max(365).optional(),
  })
  .openapi('UpdateOrderSettingsRequest');
export type UpdateOrderSettingsRequest = z.infer<typeof UpdateOrderSettingsRequest>;

// ---------------------------------------------------------------- orders

export const OrderEvent = z
  .object({
    id: Uuid,
    type: z.string(),
    fromStatus: z.string().nullable(),
    toStatus: z.string().nullable(),
    actor: ActorRef,
    note: z.string().nullable(),
    data: z.record(z.unknown()),
    createdAt: Timestamp,
  })
  .openapi('OrderEvent');
export type OrderEvent = z.infer<typeof OrderEvent>;

export const Payment = z
  .object({
    id: Uuid,
    provider: z.literal('sandbox'),
    status: z.enum(['pending', 'captured', 'failed']),
    amountMinor: MinorAmount,
    currency: CurrencyCode,
    failureReason: z.string().nullable(),
    /** Refunds requested or completed against this payment. */
    refundedMinor: MinorAmount,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('Payment');
export type Payment = z.infer<typeof Payment>;

export const OrderLine = z
  .object({
    lineNo: z.number().int(),
    variantId: Uuid,
    serialItemId: Uuid.nullable(),
    sku: z.string(),
    title: z.string(),
    serialTag: z.string().nullable(),
    quantity: z.number().int(),
    totalMinor: MinorAmount,
    /** Frozen at order time: measurements, book, rule version, rate and full breakdown. Never recalculated. */
    priceSnapshot: QuoteLine,
    reservation: z.object({ id: Uuid, status: z.string(), locationName: z.string() }).nullable(),
    /** Phase 09: units shipped, still to ship (committed and not in a shipment), and returned (received). */
    shippedQuantity: z.number().int(),
    shippableQuantity: z.number().int(),
    returnedQuantity: z.number().int(),
  })
  .openapi('OrderLine');
export type OrderLine = z.infer<typeof OrderLine>;

export const OrderSummary = z
  .object({
    id: Uuid,
    number: z.string(),
    channel: z.object({ id: Uuid, name: z.string() }).nullable(),
    origin: z.enum(['storefront', 'admin', 'quotation']),
    status: OrderStatus,
    paymentStatus: PaymentStatus,
    fulfillmentStatus: FulfillmentStatus,
    contactName: z.string(),
    contactEmail: z.string(),
    currency: CurrencyCode,
    totalMinor: MinorAmount,
    lineCount: z.number().int(),
    createdAt: Timestamp,
  })
  .openapi('OrderSummary');
export type OrderSummary = z.infer<typeof OrderSummary>;
export const OrderPage = pageOf(OrderSummary).openapi('OrderPage');
export const OrderListQuery = PageQuery.extend({
  status: OrderStatus.optional(),
  paymentStatus: PaymentStatus.optional(),
  channelId: Uuid.optional(),
  origin: z.enum(['storefront', 'admin', 'quotation']).optional(),
  fulfillmentStatus: FulfillmentStatus.optional(),
  customerId: Uuid.optional(),
  q: z.string().trim().max(100).optional(),
});
export type OrderListQuery = z.infer<typeof OrderListQuery>;

export const Order = OrderSummary.extend({
  paymentTerms: PaymentTerms,
  contact: Contact,
  shippingAddress: Address.nullable(),
  note: z.string().nullable(),
  subtotalMinor: MinorAmount,
  discountMinor: MinorAmount,
  taxMinor: MinorAmount,
  refundDueMinor: MinorAmount,
  priceQuoteId: Uuid.nullable(),
  quotationId: Uuid.nullable(),
  lines: z.array(OrderLine),
  payments: z.array(Payment),
  events: z.array(OrderEvent),
  exports: z.array(z.object({ connectionName: z.string(), reference: z.string(), status: z.string(), externalRef: z.string().nullable() })),
  createdBy: ActorRef,
  approvedBy: ActorRef,
  approvedAt: Timestamp.nullable(),
  confirmedAt: Timestamp.nullable(),
  cancelledAt: Timestamp.nullable(),
  cancelReason: z.string().nullable(),
  expiresAt: Timestamp.nullable(),
  warnings: z.array(z.string()),
  customer: z.object({ id: Uuid, name: z.string(), email: z.string() }).nullable(),
  shipments: z.array(Shipment),
  returns: z.array(OrderReturn),
  refunds: z.array(Refund),
  messages: z.array(CustomerMessage),
  version: Version,
}).openapi('Order');
export type Order = z.infer<typeof Order>;

export const CreateOrderRequest = z
  .object({
    channelId: Uuid.nullable().default(null),
    contact: Contact,
    shippingAddress: Address.nullable().default(null),
    note: z.string().trim().max(1000).nullable().default(null),
    lines: z.array(QuoteLineInput).min(1).max(50),
  })
  .openapi('CreateOrderRequest');
export type CreateOrderRequest = z.infer<typeof CreateOrderRequest>;
export const CancelOrderRequest = z.object({ reason: Reason }).openapi('CancelOrderRequest');
export type CancelOrderRequest = z.infer<typeof CancelOrderRequest>;
export const ApproveOrderRequest = z.object({ note: z.string().trim().max(500).optional() }).openapi('ApproveOrderRequest');
export type ApproveOrderRequest = z.infer<typeof ApproveOrderRequest>;
export const RejectOrderRequest = z.object({ reason: Reason }).openapi('RejectOrderRequest');
export type RejectOrderRequest = z.infer<typeof RejectOrderRequest>;

// ---------------------------------------------------------------- storefront cart & checkout

export const CreateCartResponse = z
  .object({ cartId: Uuid, cartToken: z.string(), expiresAt: Timestamp })
  .openapi('CreateCartResponse');
export const PutCartLinesRequest = z.object({ lines: z.array(QuoteLineInput).max(20) }).openapi('PutCartLinesRequest');
export type PutCartLinesRequest = z.infer<typeof PutCartLinesRequest>;
export const Cart = z
  .object({
    id: Uuid,
    status: z.enum(['open', 'converted', 'abandoned']),
    lines: z.array(z.object({ variantId: Uuid, serialItemId: Uuid.nullable(), quantity: z.number().int() })),
    /** Server price for the current lines (a fresh, time-limited quote), null when the cart is empty. */
    quote: StorefrontQuote.nullable(),
    orderId: Uuid.nullable(),
  })
  .openapi('Cart');
export type Cart = z.infer<typeof Cart>;

export const CheckoutRequest = z
  .object({
    cartId: Uuid,
    cartToken: z.string().min(20).max(200),
    /** The quote the shopper saw. */
    quoteId: Uuid,
    /** The total the shopper accepted; it must equal the server price, it never sets it. */
    acknowledgedTotalMinor: MinorAmount,
    contact: Contact,
    shippingAddress: Address,
  })
  .openapi('CheckoutRequest');
export type CheckoutRequest = z.infer<typeof CheckoutRequest>;

export const StorefrontOrder = z
  .object({
    id: Uuid,
    number: z.string(),
    status: OrderStatus,
    paymentStatus: PaymentStatus,
    fulfillmentStatus: FulfillmentStatus,
    currency: CurrencyCode,
    totalMinor: MinorAmount,
    lines: z.array(z.object({ title: z.string(), quantity: z.number().int(), totalMinor: MinorAmount })),
    payment: z
      .object({ id: Uuid, status: z.enum(['pending', 'captured', 'failed']), sandbox: z.literal(true), amountMinor: MinorAmount })
      .nullable(),
    expiresAt: Timestamp.nullable(),
    createdAt: Timestamp,
  })
  .openapi('StorefrontOrder');
export type StorefrontOrder = z.infer<typeof StorefrontOrder>;

export const SandboxPayRequest = z
  .object({ cartToken: z.string().min(20).max(200), outcome: z.enum(['succeeded', 'failed']) })
  .openapi('SandboxPayRequest');
export type SandboxPayRequest = z.infer<typeof SandboxPayRequest>;

/** Body of a sandbox PSP callback. The signature header is HMAC-SHA256 over the raw body. */
export const SandboxWebhook = z
  .object({
    eventId: z.string().min(8).max(100),
    paymentId: Uuid,
    /** Phase 09: present when the callback settles a refund of this payment rather than the payment itself. */
    refundId: Uuid.optional(),
    outcome: z.enum(['succeeded', 'failed']),
    amountMinor: MinorAmount,
    currency: CurrencyCode,
    occurredAt: z.string().datetime(),
  })
  .openapi('SandboxWebhook');
export type SandboxWebhook = z.infer<typeof SandboxWebhook>;
export const WebhookAck = z.object({ received: z.literal(true), duplicate: z.boolean() }).openapi('WebhookAck');

// ---------------------------------------------------------------- quotations

export const QuotationStatus = z.enum(['draft', 'sent', 'accepted', 'converted', 'cancelled', 'expired']);
export type QuotationStatus = z.infer<typeof QuotationStatus>;
export const Quotation = z
  .object({
    id: Uuid,
    number: z.string(),
    status: QuotationStatus,
    channel: z.object({ id: Uuid, name: z.string() }).nullable(),
    contact: Contact,
    notes: z.string().nullable(),
    lines: z.array(QuoteLineInput),
    validUntil: Timestamp,
    /** The frozen price (set when sent). */
    priceQuote: PriceQuote.nullable(),
    currency: CurrencyCode.nullable(),
    totalMinor: MinorAmount.nullable(),
    acceptanceNote: z.string().nullable(),
    orderId: Uuid.nullable(),
    createdBy: ActorRef,
    sentAt: Timestamp.nullable(),
    acceptedAt: Timestamp.nullable(),
    cancelReason: z.string().nullable(),
    version: Version,
    createdAt: Timestamp,
  })
  .openapi('Quotation');
export type Quotation = z.infer<typeof Quotation>;
export const QuotationSummary = Quotation.pick({
  id: true,
  number: true,
  status: true,
  channel: true,
  validUntil: true,
  currency: true,
  totalMinor: true,
  createdAt: true,
})
  .extend({ contactName: z.string() })
  .openapi('QuotationSummary');
export const QuotationPage = pageOf(QuotationSummary).openapi('QuotationPage');
export const QuotationListQuery = PageQuery.extend({ status: QuotationStatus.optional(), q: z.string().trim().max(100).optional() });
export type QuotationListQuery = z.infer<typeof QuotationListQuery>;

export const CreateQuotationRequest = z
  .object({
    channelId: Uuid.nullable().default(null),
    contact: Contact,
    lines: z.array(QuoteLineInput).min(1).max(50),
    validUntil: z.string().datetime(),
    notes: z.string().trim().max(1000).nullable().default(null),
  })
  .openapi('CreateQuotationRequest');
export type CreateQuotationRequest = z.infer<typeof CreateQuotationRequest>;
export const UpdateQuotationRequest = z
  .object({
    version: Version,
    contact: Contact.optional(),
    lines: z.array(QuoteLineInput).min(1).max(50).optional(),
    validUntil: z.string().datetime().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
  })
  .openapi('UpdateQuotationRequest');
export type UpdateQuotationRequest = z.infer<typeof UpdateQuotationRequest>;
export const QuotationActionRequest = z.object({ version: Version }).openapi('QuotationActionRequest');
export type QuotationActionRequest = z.infer<typeof QuotationActionRequest>;
export const AcceptQuotationRequest = z
  .object({ version: Version, note: z.string().trim().min(5, 'Record who accepted and how').max(500) })
  .openapi('AcceptQuotationRequest');
export type AcceptQuotationRequest = z.infer<typeof AcceptQuotationRequest>;
export const ConvertQuotationRequest = z
  .object({ version: Version, shippingAddress: Address.nullable().default(null) })
  .openapi('ConvertQuotationRequest');
export type ConvertQuotationRequest = z.infer<typeof ConvertQuotationRequest>;
export const CancelQuotationRequest = z.object({ version: Version, reason: Reason }).openapi('CancelQuotationRequest');
export type CancelQuotationRequest = z.infer<typeof CancelQuotationRequest>;
