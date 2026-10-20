import { CurrencyCode, Email, PageQuery, Reason, Timestamp, Uuid, Version, pageOf } from '../common';
import { z } from '../z';
import { Address } from './admin';
import { Password } from './auth';
import { FulfillmentStatus, OrderReturn, ReturnStatus } from './fulfillment';
import { Grams, Metal } from './jewellery';
import { OrderStatus, PaymentStatus } from './orders';

/**
 * Phase 09 storefront customers (ADR-024). A customer belongs to one merchant's storefront; it is not a platform
 * user. Consent is an append-only log; the preference shown is the latest event per channel.
 */
const MinorAmount = z.string().regex(/^\d{1,18}$/, 'Whole minor units').openapi({ description: 'Integer minor units (string)' });

export const ConsentChannel = z.enum(['email', 'sms', 'whatsapp']);
export type ConsentChannel = z.infer<typeof ConsentChannel>;
export const MarketingPreferences = z
  .object({ email: z.boolean(), sms: z.boolean(), whatsapp: z.boolean() })
  .openapi('MarketingPreferences');
export type MarketingPreferences = z.infer<typeof MarketingPreferences>;
export const ConsentEvent = z
  .object({
    channel: ConsentChannel,
    purpose: z.literal('marketing'),
    granted: z.boolean(),
    source: z.enum(['registration', 'account', 'admin']),
    createdAt: Timestamp,
  })
  .openapi('ConsentEvent');

export const CustomerAddress = z
  .object({ id: Uuid, label: z.string().nullable(), address: Address, isDefault: z.boolean(), version: Version })
  .openapi('CustomerAddress');
export type CustomerAddress = z.infer<typeof CustomerAddress>;

// ---------------------------------------------------------------- admin

export const CustomerSummary = z
  .object({
    id: Uuid,
    email: z.string(),
    displayName: z.string(),
    phone: z.string().nullable(),
    status: z.enum(['active', 'disabled']),
    emailVerified: z.boolean(),
    orderCount: z.number().int(),
    isDemo: z.boolean(),
    lastLoginAt: Timestamp.nullable(),
    createdAt: Timestamp,
  })
  .openapi('CustomerSummary');
export type CustomerSummary = z.infer<typeof CustomerSummary>;
export const CustomerPage = pageOf(CustomerSummary).openapi('CustomerPage');
export const CustomerListQuery = PageQuery.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});
export type CustomerListQuery = z.infer<typeof CustomerListQuery>;
export const CustomerDetail = CustomerSummary.extend({
  preferences: MarketingPreferences,
  consentHistory: z.array(ConsentEvent),
  addresses: z.array(CustomerAddress),
  version: Version,
}).openapi('CustomerDetail');
export type CustomerDetail = z.infer<typeof CustomerDetail>;
export const UpdateCustomerStatusRequest = z
  .object({ version: Version, status: z.enum(['active', 'disabled']), reason: Reason })
  .openapi('UpdateCustomerStatusRequest');
export type UpdateCustomerStatusRequest = z.infer<typeof UpdateCustomerStatusRequest>;

// ---------------------------------------------------------------- storefront account

export const RegisterCustomerRequest = z
  .object({
    email: Email,
    password: Password,
    displayName: z.string().trim().min(1).max(120),
    phone: z.string().trim().max(30).nullable().default(null),
    /** Marketing opt-ins chosen at registration (unticked by default; transactional messages need no consent). */
    marketing: MarketingPreferences.default({ email: false, sms: false, whatsapp: false }),
  })
  .openapi('RegisterCustomerRequest');
export type RegisterCustomerRequest = z.infer<typeof RegisterCustomerRequest>;
export const CustomerLoginRequest = z
  .object({ email: Email, password: z.string().min(1).max(128) })
  .openapi('CustomerLoginRequest');
export type CustomerLoginRequest = z.infer<typeof CustomerLoginRequest>;

export const CustomerMe = z
  .object({
    customer: z.object({
      id: Uuid,
      email: z.string(),
      displayName: z.string(),
      phone: z.string().nullable(),
      emailVerified: z.boolean(),
      version: Version,
    }),
    storefront: z.object({ name: z.string(), currency: CurrencyCode, isDemo: z.boolean() }),
    preferences: MarketingPreferences,
    returnWindowDays: z.number().int(),
    sessionExpiresAt: Timestamp,
  })
  .openapi('CustomerMe');
export type CustomerMe = z.infer<typeof CustomerMe>;
export const UpdateProfileRequest = z
  .object({
    version: Version,
    displayName: z.string().trim().min(1).max(120).optional(),
    phone: z.string().trim().max(30).nullable().optional(),
  })
  .openapi('UpdateProfileRequest');
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequest>;
export const UpdatePreferencesRequest = MarketingPreferences.partial().openapi('UpdatePreferencesRequest');
export type UpdatePreferencesRequest = z.infer<typeof UpdatePreferencesRequest>;
export const SaveAddressRequest = z
  .object({ label: z.string().trim().max(60).nullable().default(null), address: Address, isDefault: z.boolean().default(false) })
  .openapi('SaveAddressRequest');
export type SaveAddressRequest = z.infer<typeof SaveAddressRequest>;
export const UpdateAddressRequest = SaveAddressRequest.extend({ version: Version }).openapi('UpdateAddressRequest');
export type UpdateAddressRequest = z.infer<typeof UpdateAddressRequest>;

export const CustomerOrderSummary = z
  .object({
    id: Uuid,
    number: z.string(),
    status: OrderStatus,
    paymentStatus: PaymentStatus,
    fulfillmentStatus: FulfillmentStatus,
    currency: CurrencyCode,
    totalMinor: MinorAmount,
    lineCount: z.number().int(),
    createdAt: Timestamp,
  })
  .openapi('CustomerOrderSummary');
export const CustomerOrderPage = pageOf(CustomerOrderSummary).openapi('CustomerOrderPage');
export const CustomerOrder = CustomerOrderSummary.extend({
  lines: z.array(
    z.object({
      lineNo: z.number().int(),
      sku: z.string(),
      title: z.string(),
      serialTag: z.string().nullable(),
      quantity: z.number().int(),
      totalMinor: MinorAmount,
      shippedQuantity: z.number().int(),
      /** Shipped units not yet in a return. */
      returnableQuantity: z.number().int(),
    }),
  ),
  shippingAddress: Address.nullable(),
  shipments: z.array(
    z.object({
      number: z.string(),
      status: z.enum(['shipped', 'delivered']),
      carrier: z.string().nullable(),
      trackingNumber: z.string().nullable(),
      trackingManual: z.literal(true),
      shippedAt: Timestamp.nullable(),
      deliveredAt: Timestamp.nullable(),
      lines: z.array(z.object({ lineNo: z.number().int(), quantity: z.number().int() })),
    }),
  ),
  returns: z.array(OrderReturn.pick({ id: true, number: true, status: true, reason: true, valueMinor: true, createdAt: true, decisionNote: true })),
  refunds: z.array(z.object({ amountMinor: MinorAmount, status: z.enum(['pending', 'succeeded', 'failed']), createdAt: Timestamp })),
  messages: z.array(z.object({ subject: z.string(), status: z.enum(['not_sent', 'sent', 'failed']), createdAt: Timestamp })),
  /** Last moment a return can be requested; null until something shipped. */
  returnDeadline: Timestamp.nullable(),
}).openapi('CustomerOrder');
export type CustomerOrder = z.infer<typeof CustomerOrder>;
export const CustomerReturnSummary = z
  .object({ id: Uuid, number: z.string(), status: ReturnStatus })
  .openapi('CustomerReturnSummary');

// ---------------------------------------------------------------- storefront pieces

export const StorefrontPiece = z
  .object({
    /** Use as `serialItemId` on a cart line to buy exactly this piece. */
    id: Uuid,
    variantId: Uuid,
    sku: z.string(),
    tag: z.string(),
    metal: Metal,
    purity: z.string(),
    grossG: Grams.nullable(),
    netG: Grams.nullable(),
    stoneG: Grams.nullable(),
  })
  .openapi('StorefrontPiece');
export type StorefrontPiece = z.infer<typeof StorefrontPiece>;
export const StorefrontPieceList = z.object({ items: z.array(StorefrontPiece) }).openapi('StorefrontPieceList');
