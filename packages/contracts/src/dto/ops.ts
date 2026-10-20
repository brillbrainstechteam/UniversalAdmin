import { PageQuery, Timestamp, Uuid, Version, pageOf } from '../common';
import { z } from '../z';
import type { DomainEventType } from '../events';
import type { TenantPermission } from '../permissions';

/**
 * Phase 11 operations: outbound webhooks, automations, staff notifications, API keys, MFA, operations health
 * (ADR-026). Webhook URLs are merchant input: the server refuses private targets outside development.
 */
const MinorAmount = z.string().regex(/^\d{1,18}$/, 'Whole minor units');

/** Domain events a merchant may receive by webhook or use as an automation trigger. */
export const WEBHOOK_EVENT_TYPES = [
  'OrderConfirmed',
  'OrderCancelled',
  'PaymentCaptured',
  'PaymentRefunded',
  'ShipmentDispatched',
  'ShipmentDelivered',
  'ReturnRequested',
  'ReturnReceived',
  'ProductPublished',
  'ProductUnpublished',
  'ReconciliationIssueOpened',
  'RateStale',
] as const satisfies readonly DomainEventType[];
export const WebhookEventType = z.enum(WEBHOOK_EVENT_TYPES);
export type WebhookEventType = z.infer<typeof WebhookEventType>;

// ---------------------------------------------------------------- webhooks

export const WebhookUrl = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((u) => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u), 'Use an https:// URL');
export const WebhookEndpoint = z
  .object({
    id: Uuid,
    name: z.string(),
    url: z.string(),
    eventTypes: z.array(WebhookEventType),
    status: z.enum(['active', 'disabled']),
    secretHint: z.string(),
    consecutiveFailures: z.number().int(),
    lastSuccessAt: Timestamp.nullable(),
    lastFailureAt: Timestamp.nullable(),
    version: Version,
    createdAt: Timestamp,
  })
  .openapi('WebhookEndpoint');
export type WebhookEndpoint = z.infer<typeof WebhookEndpoint>;
export const SaveWebhookEndpointRequest = z
  .object({
    name: z.string().trim().min(1).max(80),
    url: WebhookUrl,
    eventTypes: z.array(WebhookEventType).min(1).max(WEBHOOK_EVENT_TYPES.length),
    status: z.enum(['active', 'disabled']).default('active'),
    version: Version.optional(),
  })
  .openapi('SaveWebhookEndpointRequest');
export type SaveWebhookEndpointRequest = z.infer<typeof SaveWebhookEndpointRequest>;
/** The signing secret is returned only here (create / rotate). */
export const WebhookSecretResponse = z.object({ endpoint: WebhookEndpoint, secret: z.string() }).openapi('WebhookSecretResponse');
export const WebhookDelivery = z
  .object({
    id: Uuid,
    eventId: Uuid,
    eventType: z.string(),
    source: z.enum(['event', 'automation', 'test']),
    status: z.enum(['pending', 'delivered', 'failed', 'dead']),
    attempts: z.number().int(),
    nextAttemptAt: Timestamp,
    lastStatusCode: z.number().int().nullable(),
    lastError: z.string().nullable(),
    deliveredAt: Timestamp.nullable(),
    createdAt: Timestamp,
  })
  .openapi('WebhookDelivery');
export const WebhookDeliveryPage = pageOf(WebhookDelivery).openapi('WebhookDeliveryPage');
export const WebhookDeliveryQuery = PageQuery.extend({ status: z.enum(['pending', 'delivered', 'failed', 'dead']).optional() });
export type WebhookDeliveryQuery = z.infer<typeof WebhookDeliveryQuery>;

// ---------------------------------------------------------------- automations

export const AutomationConditions = z
  .object({
    /** Only events about orders whose total is at least this (minor units of the order currency). */
    minOrderTotalMinor: MinorAmount.nullable().default(null),
    /** Only events about orders on this channel. */
    channelId: Uuid.nullable().default(null),
  })
  .openapi('AutomationConditions');
export type AutomationConditions = z.infer<typeof AutomationConditions>;
export const AutomationAction = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('webhook'), endpointId: Uuid }),
    z.object({ type: z.literal('notify_staff'), title: z.string().trim().min(1).max(120) }),
  ])
  .openapi('AutomationAction');
export type AutomationAction = z.infer<typeof AutomationAction>;
export const Automation = z
  .object({
    id: Uuid,
    name: z.string(),
    trigger: WebhookEventType,
    conditions: AutomationConditions,
    action: AutomationAction,
    status: z.enum(['active', 'paused']),
    runs: z.object({ done: z.number().int(), skipped: z.number().int(), failed: z.number().int() }),
    lastRunAt: Timestamp.nullable(),
    version: Version,
    createdAt: Timestamp,
  })
  .openapi('Automation');
export type Automation = z.infer<typeof Automation>;
export const SaveAutomationRequest = z
  .object({
    name: z.string().trim().min(1).max(80),
    trigger: WebhookEventType,
    conditions: AutomationConditions.default({ minOrderTotalMinor: null, channelId: null }),
    action: AutomationAction,
    status: z.enum(['active', 'paused']).default('active'),
    version: Version.optional(),
  })
  .openapi('SaveAutomationRequest');
export type SaveAutomationRequest = z.infer<typeof SaveAutomationRequest>;
export const AutomationRun = z
  .object({ id: Uuid, eventId: Uuid, outcome: z.enum(['done', 'skipped', 'failed']), detail: z.string().nullable(), createdAt: Timestamp })
  .openapi('AutomationRun');

// ---------------------------------------------------------------- staff notifications

export const StaffNotification = z
  .object({ id: Uuid, title: z.string(), body: z.string().nullable(), link: z.string().nullable(), source: z.string(), read: z.boolean(), createdAt: Timestamp })
  .openapi('StaffNotification');
export const StaffNotificationList = z
  .object({ items: z.array(StaffNotification), unread: z.number().int() })
  .openapi('StaffNotificationList');

// ---------------------------------------------------------------- API keys

/** Read-only scopes an API key may carry (and only if its creator has them). */
export const API_KEY_SCOPES = ['catalog.read', 'inventory.read', 'orders.read', 'pricing.read', 'customers.read'] as const satisfies readonly TenantPermission[];
export const ApiKeyScope = z.enum(API_KEY_SCOPES);
export const ApiKey = z
  .object({
    id: Uuid,
    name: z.string(),
    prefix: z.string(),
    scopes: z.array(ApiKeyScope),
    createdBy: z.object({ id: Uuid, name: z.string() }),
    expiresAt: Timestamp.nullable(),
    lastUsedAt: Timestamp.nullable(),
    revokedAt: Timestamp.nullable(),
    createdAt: Timestamp,
  })
  .openapi('ApiKey');
export type ApiKey = z.infer<typeof ApiKey>;
export const CreateApiKeyRequest = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z.array(ApiKeyScope).min(1),
    expiresInDays: z.number().int().min(1).max(730).nullable().default(90),
  })
  .openapi('CreateApiKeyRequest');
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequest>;
/** The key is returned only once. */
export const CreatedApiKey = z.object({ apiKey: ApiKey, key: z.string() }).openapi('CreatedApiKey');

// ---------------------------------------------------------------- MFA

export const MfaStatus = z.object({ enrolled: z.boolean(), recoveryCodesLeft: z.number().int(), required: z.boolean() }).openapi('MfaStatus');
export const MfaEnrollment = z.object({ secret: z.string(), otpauthUri: z.string() }).openapi('MfaEnrollment');
export const MfaCode = z.string().trim().regex(/^(\d{6}|[a-z0-9]{4}-[a-z0-9]{4})$/, 'A 6-digit code or a recovery code');
export const MfaConfirmRequest = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'A 6-digit code') }).openapi('MfaConfirmRequest');
export const MfaRecoveryCodes = z.object({ recoveryCodes: z.array(z.string()) }).openapi('MfaRecoveryCodes');
export const MfaDisableRequest = z.object({ password: z.string().min(1).max(128), code: MfaCode }).openapi('MfaDisableRequest');
export const MfaVerifyRequest = z.object({ challengeToken: z.string().min(20).max(200), code: MfaCode }).openapi('MfaVerifyRequest');
export type MfaVerifyRequest = z.infer<typeof MfaVerifyRequest>;
export const MfaSettingRequest = z.object({ requireMfaForAdmins: z.boolean() }).openapi('MfaSettingRequest');

// ---------------------------------------------------------------- operations health

export const HealthCheck = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number(),
  unit: z.enum(['count', 'minutes', 'hours', 'percent']),
  status: z.enum(['ok', 'warn', 'alert']),
  /** e.g. "warn ≥ 10, alert ≥ 100" — thresholds are documented with the check. */
  thresholds: z.string(),
  detail: z.string().nullable(),
});
export const OpsHealth = z
  .object({ status: z.enum(['ok', 'warn', 'alert']), checks: z.array(HealthCheck), generatedAt: Timestamp })
  .openapi('OpsHealth');
export type OpsHealth = z.infer<typeof OpsHealth>;
export const DeadEvent = z
  .object({ id: Uuid, tenantId: Uuid.nullable(), eventType: z.string(), attempts: z.number().int(), lastError: z.string().nullable(), occurredAt: Timestamp })
  .openapi('DeadEvent');
export const DeadEventList = z.object({ items: z.array(DeadEvent) }).openapi('DeadEventList');

// ---------------------------------------------------------------- connectors (interfaces)

export const ProviderStatus = z
  .object({
    kind: z.enum(['payment', 'shipping', 'notification']),
    key: z.string(),
    name: z.string(),
    status: z.enum(['sandbox', 'blocked', 'not_configured']),
    capabilities: z.array(z.string()),
    detail: z.string(),
  })
  .openapi('ProviderStatus');
export const ProviderList = z.object({ items: z.array(ProviderStatus) }).openapi('ProviderList');
