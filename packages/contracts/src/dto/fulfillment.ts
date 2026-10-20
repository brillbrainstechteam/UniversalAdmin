import { CurrencyCode, PageQuery, Reason, Timestamp, Uuid, Version, pageOf } from '../common';
import { z } from '../z';
import { ActorRef } from './inventory';

/**
 * Phase 09 fulfilment, returns, refunds and customer messages (ADR-024). Carrier and tracking numbers are typed by
 * staff — no courier is connected; refunds settle only through the (sandbox) gateway callback; messages are recorded
 * but not delivered until a notification connector exists.
 */
const MinorAmount = z.string().regex(/^\d{1,18}$/, 'Whole minor units').openapi({ description: 'Integer minor units (string)' });

export const FulfillmentStatus = z.enum(['unfulfilled', 'partial', 'fulfilled']);
export type FulfillmentStatus = z.infer<typeof FulfillmentStatus>;

// ---------------------------------------------------------------- shipments

export const ShipmentStatus = z.enum(['packed', 'shipped', 'delivered', 'cancelled']);
export const Shipment = z
  .object({
    id: Uuid,
    number: z.string(),
    status: ShipmentStatus,
    carrier: z.string().nullable(),
    trackingNumber: z.string().nullable(),
    /** Always true in this build: no courier API checks the tracking number. */
    trackingManual: z.literal(true),
    note: z.string().nullable(),
    lines: z.array(z.object({ lineNo: z.number().int(), sku: z.string(), title: z.string(), serialTag: z.string().nullable(), quantity: z.number().int() })),
    createdBy: ActorRef,
    createdAt: Timestamp,
    shippedAt: Timestamp.nullable(),
    deliveredAt: Timestamp.nullable(),
    cancelledAt: Timestamp.nullable(),
    version: Version,
  })
  .openapi('Shipment');
export type Shipment = z.infer<typeof Shipment>;

export const CreateShipmentRequest = z
  .object({
    lines: z.array(z.object({ lineNo: z.number().int().min(1), quantity: z.number().int().min(1).max(100_000) })).min(1).max(100),
    note: z.string().trim().max(500).nullable().default(null),
  })
  .openapi('CreateShipmentRequest');
export type CreateShipmentRequest = z.infer<typeof CreateShipmentRequest>;
export const ShipShipmentRequest = z
  .object({
    version: Version,
    carrier: z.string().trim().min(1).max(80),
    trackingNumber: z.string().trim().max(80).nullable().default(null),
  })
  .openapi('ShipShipmentRequest');
export type ShipShipmentRequest = z.infer<typeof ShipShipmentRequest>;
export const ShipmentActionRequest = z.object({ version: Version }).openapi('ShipmentActionRequest');
export type ShipmentActionRequest = z.infer<typeof ShipmentActionRequest>;
export const CancelRemainingRequest = z.object({ reason: Reason }).openapi('CancelRemainingRequest');
export type CancelRemainingRequest = z.infer<typeof CancelRemainingRequest>;

// ---------------------------------------------------------------- returns

export const ReturnStatus = z.enum(['requested', 'approved', 'rejected', 'received']);
export type ReturnStatus = z.infer<typeof ReturnStatus>;
export const OrderReturn = z
  .object({
    id: Uuid,
    number: z.string(),
    orderId: Uuid,
    orderNumber: z.string(),
    status: ReturnStatus,
    reason: z.string(),
    requestedBy: z.enum(['customer', 'staff']),
    currency: CurrencyCode,
    valueMinor: MinorAmount,
    lines: z.array(z.object({ lineNo: z.number().int(), sku: z.string(), title: z.string(), serialTag: z.string().nullable(), quantity: z.number().int(), valueMinor: MinorAmount })),
    decidedBy: ActorRef,
    decidedAt: Timestamp.nullable(),
    decisionNote: z.string().nullable(),
    receivedAt: Timestamp.nullable(),
    restocked: z.boolean().nullable(),
    createdAt: Timestamp,
    version: Version,
  })
  .openapi('OrderReturn');
export type OrderReturn = z.infer<typeof OrderReturn>;
export const ReturnPage = pageOf(OrderReturn).openapi('ReturnPage');
export const ReturnListQuery = PageQuery.extend({ status: ReturnStatus.optional() });
export type ReturnListQuery = z.infer<typeof ReturnListQuery>;

export const CreateReturnRequest = z
  .object({
    lines: z.array(z.object({ lineNo: z.number().int().min(1), quantity: z.number().int().min(1).max(100_000) })).min(1).max(100),
    reason: z.string().trim().min(3).max(500),
  })
  .openapi('CreateReturnRequest');
export type CreateReturnRequest = z.infer<typeof CreateReturnRequest>;
export const DecideReturnRequest = z
  .object({ version: Version, approve: z.boolean(), note: z.string().trim().max(500).nullable().default(null) })
  .superRefine((v, ctx) => {
    if (!v.approve && !v.note) ctx.addIssue({ code: 'custom', path: ['note'], message: 'Give a reason to reject a return' });
  })
  .openapi('DecideReturnRequest');
export type DecideReturnRequest = z.infer<typeof DecideReturnRequest>;
export const ReceiveReturnRequest = z
  .object({
    version: Version,
    /** true: back to sellable stock at `locationId`; false: received but not restocked (pieces written off). */
    restock: z.boolean(),
    locationId: Uuid,
  })
  .openapi('ReceiveReturnRequest');
export type ReceiveReturnRequest = z.infer<typeof ReceiveReturnRequest>;

// ---------------------------------------------------------------- refunds

export const Refund = z
  .object({
    id: Uuid,
    paymentId: Uuid,
    returnId: Uuid.nullable(),
    provider: z.literal('sandbox'),
    status: z.enum(['pending', 'succeeded', 'failed']),
    amountMinor: MinorAmount,
    currency: CurrencyCode,
    reason: z.string(),
    failureReason: z.string().nullable(),
    createdBy: ActorRef,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('Refund');
export type Refund = z.infer<typeof Refund>;
export const CreateRefundRequest = z
  .object({
    amountMinor: MinorAmount.refine((v) => BigInt(v) > 0n, 'Refund must be more than zero'),
    reason: z.string().trim().min(3).max(500),
    returnId: Uuid.nullable().default(null),
    /** Sandbox only: the simulated gateway's answer. */
    sandboxOutcome: z.enum(['succeeded', 'failed']).default('succeeded'),
  })
  .openapi('CreateRefundRequest');
export type CreateRefundRequest = z.infer<typeof CreateRefundRequest>;

// ---------------------------------------------------------------- messages

export const CustomerMessage = z
  .object({
    id: Uuid,
    template: z.string(),
    channel: z.literal('email'),
    recipient: z.string(),
    subject: z.string(),
    body: z.string(),
    status: z.enum(['not_sent', 'sent', 'failed']),
    statusReason: z.string().nullable(),
    createdAt: Timestamp,
  })
  .openapi('CustomerMessage');
export type CustomerMessage = z.infer<typeof CustomerMessage>;
