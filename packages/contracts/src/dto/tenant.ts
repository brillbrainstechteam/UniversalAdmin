import {
  Code,
  CountryCode,
  CurrencyCode,
  Email,
  Locale,
  Reason,
  TimeZone,
  Timestamp,
  Uuid,
  Version,
  pageOf,
  PageQuery,
} from '../common';
import { FEATURE_KEYS, PRESET_KEYS, type FeatureKey, type PresetKey } from '../features';
import { z } from '../z';

export const TenantStatus = z.enum(['provisioning', 'active', 'suspended']);
export const PresetKeySchema = z.enum(PRESET_KEYS as [PresetKey, ...PresetKey[]]);
export const FeatureKeySchema = z.enum(FEATURE_KEYS as [FeatureKey, ...FeatureKey[]]);

const TenantCore = {
  id: Uuid,
  slug: z.string(),
  displayName: z.string(),
  legalName: z.string(),
  status: TenantStatus,
  preset: PresetKeySchema,
  countryCode: z.string(),
  defaultCurrency: z.string(),
  timezone: z.string(),
  defaultLocale: z.string(),
  isDemo: z.boolean(),
  planKey: z.string(),
  version: Version,
  createdAt: Timestamp,
  updatedAt: Timestamp,
};

export const TenantSummary = z.object({ ...TenantCore, memberCount: z.number().int() }).openapi('TenantSummary');
export type TenantSummary = z.infer<typeof TenantSummary>;

export const FeatureEntitlement = z
  .object({
    key: FeatureKeySchema,
    label: z.string(),
    description: z.string(),
    presetDefault: z.boolean(),
    override: z.boolean().nullable(),
    effective: z.boolean(),
  })
  .openapi('FeatureEntitlement');
export type FeatureEntitlement = z.infer<typeof FeatureEntitlement>;

export const TenantDetail = z
  .object({
    ...TenantCore,
    contactEmail: z.string().nullable(),
    contactPhone: z.string().nullable(),
    suspendedReason: z.string().nullable(),
    counts: z.object({
      stores: z.number().int(),
      channels: z.number().int(),
      locations: z.number().int(),
      activeMembers: z.number().int(),
      pendingInvitations: z.number().int(),
    }),
    entitlements: z.array(FeatureEntitlement),
  })
  .openapi('TenantDetail');
export type TenantDetail = z.infer<typeof TenantDetail>;

export const TenantListQuery = PageQuery.extend({
  q: z.string().trim().max(100).optional(),
  status: TenantStatus.optional(),
  preset: PresetKeySchema.optional(),
  sort: z.enum(['createdAt', '-createdAt', 'displayName', '-displayName']).default('-createdAt'),
});
export type TenantListQuery = z.infer<typeof TenantListQuery>;
export const TenantPage = pageOf(TenantSummary).openapi('TenantPage');

export const CreateTenantRequest = z
  .object({
    slug: Code,
    displayName: z.string().trim().min(2).max(120),
    legalName: z.string().trim().min(2).max(200),
    preset: PresetKeySchema,
    countryCode: CountryCode,
    defaultCurrency: CurrencyCode,
    timezone: TimeZone,
    defaultLocale: Locale,
    contactEmail: Email,
    ownerEmail: Email,
    isDemo: z.boolean().default(false),
    /** Phase 12: plan with usage limits (defaults to the pilot plan). */
    planKey: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/).default('pilot'),
  })
  .openapi('CreateTenantRequest');
export type CreateTenantRequest = z.infer<typeof CreateTenantRequest>;

export const OwnerInvitation = z
  .object({ email: z.string(), inviteUrl: z.string(), expiresAt: Timestamp })
  .openapi('OwnerInvitation');

export const CreateTenantResponse = z
  .object({ tenant: TenantDetail, ownerInvitation: OwnerInvitation })
  .openapi('CreateTenantResponse');
export type CreateTenantResponse = z.infer<typeof CreateTenantResponse>;

export const UpdateTenantRequest = z
  .object({
    version: Version,
    displayName: z.string().trim().min(2).max(120).optional(),
    legalName: z.string().trim().min(2).max(200).optional(),
    preset: PresetKeySchema.optional(),
    countryCode: CountryCode.optional(),
    defaultCurrency: CurrencyCode.optional(),
    timezone: TimeZone.optional(),
    defaultLocale: Locale.optional(),
    contactEmail: Email.optional(),
  })
  .openapi('UpdateTenantRequest');
export type UpdateTenantRequest = z.infer<typeof UpdateTenantRequest>;

export const TenantStatusChangeRequest = z
  .object({ version: Version, reason: Reason })
  .openapi('TenantStatusChangeRequest');
export type TenantStatusChangeRequest = z.infer<typeof TenantStatusChangeRequest>;

export const EntitlementsResponse = z
  .object({ preset: PresetKeySchema, features: z.array(FeatureEntitlement) })
  .openapi('EntitlementsResponse');
export type EntitlementsResponse = z.infer<typeof EntitlementsResponse>;

export const UpdateEntitlementsRequest = z
  .object({
    /** true/false = explicit override, null = follow preset default. Omitted keys are unchanged. */
    overrides: z.record(FeatureKeySchema, z.boolean().nullable()),
    reason: Reason,
  })
  .openapi('UpdateEntitlementsRequest');
export type UpdateEntitlementsRequest = z.infer<typeof UpdateEntitlementsRequest>;

export const PresetCatalogResponse = z
  .object({
    presets: z.array(z.object({ key: PresetKeySchema, label: z.string(), features: z.array(FeatureKeySchema) })),
    features: z.array(z.object({ key: FeatureKeySchema, label: z.string(), description: z.string() })),
  })
  .openapi('PresetCatalogResponse');
export type PresetCatalogResponse = z.infer<typeof PresetCatalogResponse>;
