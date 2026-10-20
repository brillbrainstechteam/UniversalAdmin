import { z } from './z';

/**
 * Canonical domain event names (contracts/API-AND-EVENTS.md) plus platform lifecycle events added in Phase 01.
 */
export const DOMAIN_EVENT_TYPES = [
  // Phase 01 platform lifecycle
  'TenantProvisioned',
  'TenantSuspended',
  'TenantReactivated',
  'TenantEntitlementsChanged',
  'MembershipChanged',
  // Canonical contract events (emitted from the phases that implement them)
  'ProductPublished',
  'ProductUnpublished',
  'InventorySnapshotReceived',
  'InventoryMovementRecorded',
  'ReservationCreated',
  'ReservationCommitted',
  'ReservationReleased',
  'ReservationExpired',
  'ReservationFulfilled',
  'RateProposed',
  'RateApproved',
  'RatePublished',
  'RateStale',
  'PriceRulePublished',
  'QuoteSent',
  'QuoteAccepted',
  'QuoteExpired',
  'OrderConfirmed',
  'OrderCancelled',
  'OrderExportRequested',
  'OrderExportAcknowledged',
  'OrderExportFailed',
  'PaymentAuthorized',
  'PaymentCaptured',
  'PaymentFailed',
  'PaymentRefunded',
  'RefundFailed',
  'ReturnRequested',
  'ReturnReceived',
  'CustomerRegistered',
  'ShipmentDispatched',
  'ShipmentDelivered',
  'ReturnApproved',
  'SyncJobCompleted',
  'SyncJobFailed',
  'ReconciliationIssueOpened',
  'ReconciliationIssueResolved',
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

export const EventEnvelope = z
  .object({
    eventId: z.string().uuid(),
    eventType: z.enum(DOMAIN_EVENT_TYPES),
    eventVersion: z.number().int().positive(),
    tenantId: z.string().uuid().nullable(),
    aggregateType: z.string(),
    aggregateId: z.string(),
    aggregateVersion: z.number().int().nonnegative(),
    occurredAt: z.string().datetime(),
    correlationId: z.string().nullable(),
    causationId: z.string().nullable(),
    payload: z.record(z.unknown()),
  })
  .openapi('EventEnvelope');
export type EventEnvelope = z.infer<typeof EventEnvelope>;

export const DOMAIN_EVENTS_QUEUE = 'domain-events';
