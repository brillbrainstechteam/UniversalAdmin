import { Timestamp, Uuid, Version } from '../common';
import { z } from '../z';

/**
 * Phase 12 launch: plans and usage limits, merchant setup checklist, just-in-time support access, pilot connector
 * checklist (ADR-027). Plans carry no price: subscription billing needs a billing provider (blocked).
 */

/** Hard limits refuse new records over the limit; `ordersPerMonth` is soft (warning only, never blocks a sale). */
export const PLAN_LIMIT_KEYS = ['products', 'staffSeats', 'locations', 'domains', 'ordersPerMonth'] as const;
export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number];
export const HARD_PLAN_LIMITS: readonly PlanLimitKey[] = ['products', 'staffSeats', 'locations', 'domains'];
export const PLAN_LIMIT_LABELS: Record<PlanLimitKey, string> = {
  products: 'Products',
  staffSeats: 'Staff seats (members + pending invitations)',
  locations: 'Locations',
  domains: 'Storefront domains',
  ordersPerMonth: 'Orders this month',
};

const LimitValue = z.number().int().min(0).max(10_000_000).nullable();
export const PlanLimits = z
  .object({
    products: LimitValue,
    staffSeats: LimitValue,
    locations: LimitValue,
    domains: LimitValue,
    ordersPerMonth: LimitValue,
  })
  .openapi('PlanLimits');
export type PlanLimits = z.infer<typeof PlanLimits>;

export const PlanKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,39}$/, 'Lower-case letters, digits and underscores, starting with a letter');

export const Plan = z
  .object({
    key: z.string(),
    name: z.string(),
    description: z.string(),
    limits: PlanLimits,
    status: z.enum(['active', 'retired']),
    tenantCount: z.number().int(),
    version: Version,
    updatedAt: Timestamp,
  })
  .openapi('Plan');
export type Plan = z.infer<typeof Plan>;
export const PlanList = z.object({ items: z.array(Plan) }).openapi('PlanList');
export type PlanList = z.infer<typeof PlanList>;

export const SavePlanRequest = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).default(''),
    limits: PlanLimits,
    status: z.enum(['active', 'retired']).default('active'),
    /** Required when updating an existing plan (optimistic concurrency). */
    version: Version.optional(),
  })
  .openapi('SavePlanRequest');
export type SavePlanRequest = z.infer<typeof SavePlanRequest>;

export const AssignPlanRequest = z
  .object({ planKey: PlanKey, reason: z.string().trim().min(3).max(500) })
  .openapi('AssignPlanRequest');
export type AssignPlanRequest = z.infer<typeof AssignPlanRequest>;

export const UsageLine = z
  .object({
    key: z.enum(PLAN_LIMIT_KEYS),
    label: z.string(),
    used: z.number().int(),
    limit: z.number().int().nullable(),
    hard: z.boolean(),
    /** ok < 80 %, near ≥ 80 %, at = limit reached, over = above (possible after a downgrade or for soft limits). */
    state: z.enum(['ok', 'near', 'at', 'over', 'unlimited']),
  })
  .openapi('UsageLine');
export type UsageLine = z.infer<typeof UsageLine>;

export const PlanUsage = z
  .object({
    tenantId: Uuid,
    plan: z.object({ key: z.string(), name: z.string(), description: z.string() }),
    usage: z.array(UsageLine),
    /** Start of the current month in the merchant's time zone (orders-per-month window). */
    monthStart: Timestamp,
    generatedAt: Timestamp,
    billing: z.literal('not_connected'),
  })
  .openapi('PlanUsage');
export type PlanUsage = z.infer<typeof PlanUsage>;

// ------------------------------------------------------------------ setup checklist

export const SETUP_STEP_KEYS = [
  'business_profile',
  'location',
  'store_channel',
  'staff',
  'products',
  'metal_rates',
  'payments',
  'domain',
  'catalog_source',
  'first_order',
] as const;
export type SetupStepKey = (typeof SETUP_STEP_KEYS)[number];

export const SetupStep = z
  .object({
    key: z.enum(SETUP_STEP_KEYS),
    title: z.string(),
    detail: z.string(),
    done: z.boolean(),
    /** Optional steps do not hold back the progress figure. */
    optional: z.boolean(),
    /** Admin path relative to the tenant, e.g. `/settings/locations`. */
    link: z.string(),
  })
  .openapi('SetupStep');
export type SetupStep = z.infer<typeof SetupStep>;

export const SetupChecklist = z
  .object({
    steps: z.array(SetupStep),
    requiredDone: z.number().int(),
    requiredTotal: z.number().int(),
    generatedAt: Timestamp,
  })
  .openapi('SetupChecklist');
export type SetupChecklist = z.infer<typeof SetupChecklist>;

// ------------------------------------------------------------------ support access

export const SupportGrantStatus = z.enum(['requested', 'approved', 'denied', 'revoked', 'expired']);
export type SupportGrantStatus = z.infer<typeof SupportGrantStatus>;

export const SupportGrant = z
  .object({
    id: Uuid,
    tenantId: Uuid,
    tenantName: z.string(),
    requestedBy: z.object({ id: Uuid, email: z.string(), displayName: z.string() }),
    reason: z.string(),
    ticketRef: z.string().nullable(),
    durationMinutes: z.number().int(),
    /** `expired` is derived: approved and past `expiresAt`. */
    status: SupportGrantStatus,
    decidedBy: z.string().nullable(),
    decidedAt: Timestamp.nullable(),
    decisionNote: z.string().nullable(),
    expiresAt: Timestamp.nullable(),
    startedAt: Timestamp.nullable(),
    revokedAt: Timestamp.nullable(),
    requestCount: z.number().int(),
    version: Version,
    createdAt: Timestamp,
  })
  .openapi('SupportGrant');
export type SupportGrant = z.infer<typeof SupportGrant>;
export const SupportGrantList = z.object({ items: z.array(SupportGrant) }).openapi('SupportGrantList');
export type SupportGrantList = z.infer<typeof SupportGrantList>;

export const RequestSupportAccess = z
  .object({
    reason: z.string().trim().min(10, 'Explain why access is needed (at least 10 characters)').max(500),
    ticketRef: z.string().trim().max(80).optional(),
    durationMinutes: z.number().int().min(15).max(120).default(60),
  })
  .openapi('RequestSupportAccess');
export type RequestSupportAccess = z.infer<typeof RequestSupportAccess>;

export const DecideSupportGrant = z
  .object({ version: Version, note: z.string().trim().max(500).optional() })
  .openapi('DecideSupportGrant');
export type DecideSupportGrant = z.infer<typeof DecideSupportGrant>;

export const SupportSessionStarted = z
  .object({ tenantId: Uuid, expiresAt: Timestamp, merchantAdminUrl: z.string() })
  .openapi('SupportSessionStarted');
export type SupportSessionStarted = z.infer<typeof SupportSessionStarted>;

/** Present on `GET /v1/auth/me` for a support session (drives the merchant admin banner). */
export const SupportSessionInfo = z
  .object({
    grantId: Uuid,
    tenantId: Uuid,
    tenantName: z.string(),
    reason: z.string(),
    expiresAt: Timestamp,
    readOnly: z.literal(true),
  })
  .openapi('SupportSessionInfo');
export type SupportSessionInfo = z.infer<typeof SupportSessionInfo>;

// ------------------------------------------------------------------ pilot connector checklist

export const PilotStep = z
  .object({
    key: z.string(),
    title: z.string(),
    state: z.enum(['done', 'todo', 'blocked', 'not_applicable']),
    detail: z.string(),
  })
  .openapi('PilotStep');
export type PilotStep = z.infer<typeof PilotStep>;

export const PilotChecklist = z
  .object({
    connectionId: Uuid,
    connectorKey: z.string(),
    connectorLabel: z.string(),
    steps: z.array(PilotStep),
    /** Always false until the connector has passed sandbox/pilot acceptance with the vendor (spec 05). */
    productionSupported: z.boolean(),
    generatedAt: Timestamp,
  })
  .openapi('PilotChecklist');
export type PilotChecklist = z.infer<typeof PilotChecklist>;
