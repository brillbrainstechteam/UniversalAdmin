import {
  Code,
  CountryCode,
  CurrencyCode,
  Email,
  Locale,
  PageQuery,
  TimeZone,
  Timestamp,
  Uuid,
  Version,
  pageOf,
} from '../common';
import { CHANNEL_TYPES, type ChannelType } from '../features';
import { RoleRef, UserSummary } from './auth';
import { FeatureKeySchema, PresetKeySchema, TenantStatus } from './tenant';
import { z } from '../z';

// ---------- Context / home ----------
export const NavItemSchema = z
  .object({ key: z.string(), label: z.string(), path: z.string(), section: z.enum(['main', 'settings']) })
  .openapi('NavItem');

export const AdminContext = z
  .object({
    tenant: z.object({
      id: Uuid,
      slug: z.string(),
      displayName: z.string(),
      legalName: z.string(),
      status: TenantStatus,
      preset: PresetKeySchema,
      isDemo: z.boolean(),
      countryCode: z.string(),
      defaultCurrency: z.string(),
      timezone: z.string(),
      defaultLocale: z.string(),
    }),
    user: UserSummary,
    membership: z.object({ id: Uuid, roles: z.array(RoleRef), locationScope: z.array(Uuid).nullable() }),
    permissions: z.array(z.string()),
    features: z.array(FeatureKeySchema),
    nav: z.array(NavItemSchema),
  })
  .openapi('AdminContext');
export type AdminContext = z.infer<typeof AdminContext>;

// ---------- Audit ----------
export const AuditEvent = z
  .object({
    id: Uuid,
    tenantId: Uuid.nullable(),
    action: z.string(),
    entityType: z.string(),
    entityId: z.string().nullable(),
    actorType: z.enum(['user', 'platform', 'system']),
    actor: z.object({ id: Uuid, email: z.string() }).nullable(),
    reason: z.string().nullable(),
    oldValues: z.record(z.unknown()).nullable(),
    newValues: z.record(z.unknown()).nullable(),
    correlationId: z.string().nullable(),
    createdAt: Timestamp,
  })
  .openapi('AuditEvent');
export type AuditEvent = z.infer<typeof AuditEvent>;

export const AuditQuery = PageQuery.extend({
  action: z.string().max(100).optional(),
  entityType: z.string().max(60).optional(),
  entityId: z.string().max(100).optional(),
  actorId: Uuid.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type AuditQuery = z.infer<typeof AuditQuery>;
export const PlatformAuditQuery = AuditQuery.extend({ tenantId: Uuid.optional() });
export type PlatformAuditQuery = z.infer<typeof PlatformAuditQuery>;
export const AuditPage = pageOf(AuditEvent).openapi('AuditPage');

export const HomeSummary = z
  .object({
    counts: z.object({
      stores: z.number().int(),
      channels: z.number().int(),
      activeChannels: z.number().int(),
      locations: z.number().int(),
      activeMembers: z.number().int(),
      pendingInvitations: z.number().int(),
    }),
    setupChecklist: z.array(
      z.object({ key: z.string(), label: z.string(), done: z.boolean(), path: z.string().nullable() }),
    ),
    recentActivity: z.array(AuditEvent),
    generatedAt: Timestamp,
  })
  .openapi('HomeSummary');
export type HomeSummary = z.infer<typeof HomeSummary>;

// ---------- Settings: general ----------
export const TenantSettings = z
  .object({
    displayName: z.string(),
    legalName: z.string(),
    contactEmail: z.string().nullable(),
    contactPhone: z.string().nullable(),
    countryCode: z.string(),
    defaultCurrency: z.string(),
    timezone: z.string(),
    defaultLocale: z.string(),
    version: Version,
    updatedAt: Timestamp,
  })
  .openapi('TenantSettings');
export type TenantSettings = z.infer<typeof TenantSettings>;

const Phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{6,20}$/, 'Enter a valid phone number');

export const UpdateTenantSettingsRequest = z
  .object({
    version: Version,
    displayName: z.string().trim().min(2).max(120).optional(),
    legalName: z.string().trim().min(2).max(200).optional(),
    contactEmail: Email.nullable().optional(),
    contactPhone: Phone.nullable().optional(),
    timezone: TimeZone.optional(),
    defaultLocale: Locale.optional(),
  })
  .openapi('UpdateTenantSettingsRequest');
export type UpdateTenantSettingsRequest = z.infer<typeof UpdateTenantSettingsRequest>;

// ---------- Stores ----------
export const ActiveStatus = z.enum(['active', 'inactive']);

export const Store = z
  .object({
    id: Uuid,
    code: z.string(),
    name: z.string(),
    status: ActiveStatus,
    defaultCurrency: z.string(),
    timezone: z.string(),
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('Store');
export type Store = z.infer<typeof Store>;
export const StorePage = pageOf(Store).openapi('StorePage');
export const StoreListQuery = PageQuery.extend({
  q: z.string().trim().max(100).optional(),
  status: ActiveStatus.optional(),
});

export const CreateStoreRequest = z
  .object({
    code: Code,
    name: z.string().trim().min(2).max(120),
    defaultCurrency: CurrencyCode.optional(),
    timezone: TimeZone.optional(),
  })
  .openapi('CreateStoreRequest');
export type CreateStoreRequest = z.infer<typeof CreateStoreRequest>;

export const UpdateStoreRequest = z
  .object({
    version: Version,
    name: z.string().trim().min(2).max(120).optional(),
    status: ActiveStatus.optional(),
    timezone: TimeZone.optional(),
  })
  .openapi('UpdateStoreRequest');
export type UpdateStoreRequest = z.infer<typeof UpdateStoreRequest>;

// ---------- Channels ----------
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex colour like #1a2b3c');
export const ThemeTokens = z
  .object({
    brandName: z.string().trim().min(1).max(80),
    primaryColor: HexColor,
    accentColor: HexColor,
    backgroundColor: HexColor,
    textColor: HexColor,
    fontFamily: z.enum(['system', 'serif', 'sans']),
    radius: z.enum(['none', 'sm', 'md', 'lg']),
    logoUrl: z.string().url().startsWith('https://', 'Logo must be an https URL').nullable(),
  })
  .openapi('ThemeTokens');
export type ThemeTokens = z.infer<typeof ThemeTokens>;

export const ChannelTypeSchema = z.enum(Object.keys(CHANNEL_TYPES) as [ChannelType, ...ChannelType[]]);

export const ChannelDomain = z
  .object({ hostname: z.string(), status: z.enum(['pending', 'verified']), isPrimary: z.boolean() })
  .openapi('ChannelDomain');

export const Channel = z
  .object({
    id: Uuid,
    storeId: Uuid,
    code: z.string(),
    name: z.string(),
    type: ChannelTypeSchema,
    status: ActiveStatus,
    theme: ThemeTokens,
    domains: z.array(ChannelDomain),
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('Channel');
export type Channel = z.infer<typeof Channel>;
export const ChannelPage = pageOf(Channel).openapi('ChannelPage');
export const ChannelListQuery = PageQuery.extend({
  storeId: Uuid.optional(),
  type: ChannelTypeSchema.optional(),
  status: ActiveStatus.optional(),
});

export const CreateChannelRequest = z
  .object({
    storeId: Uuid,
    code: Code,
    name: z.string().trim().min(2).max(120),
    type: ChannelTypeSchema,
    theme: ThemeTokens.optional(),
  })
  .openapi('CreateChannelRequest');
export type CreateChannelRequest = z.infer<typeof CreateChannelRequest>;

export const UpdateChannelRequest = z
  .object({
    version: Version,
    name: z.string().trim().min(2).max(120).optional(),
    status: ActiveStatus.optional(),
    theme: ThemeTokens.optional(),
  })
  .openapi('UpdateChannelRequest');
export type UpdateChannelRequest = z.infer<typeof UpdateChannelRequest>;

// ---------- Locations ----------
export const LocationType = z.enum(['warehouse', 'branch', 'showroom', 'bin']);
export const Address = z
  .object({
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().min(1).max(100),
    region: z.string().trim().max(100).nullable().optional(),
    postalCode: z.string().trim().max(20).nullable().optional(),
    countryCode: CountryCode,
  })
  .openapi('Address');
export type Address = z.infer<typeof Address>;

export const Location = z
  .object({
    id: Uuid,
    storeId: Uuid.nullable(),
    parentId: Uuid.nullable(),
    code: z.string(),
    name: z.string(),
    type: LocationType,
    status: ActiveStatus,
    address: Address.nullable(),
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('Location');
export type Location = z.infer<typeof Location>;
export const LocationPage = pageOf(Location).openapi('LocationPage');
export const LocationListQuery = PageQuery.extend({
  q: z.string().trim().max(100).optional(),
  type: LocationType.optional(),
  status: ActiveStatus.optional(),
  sort: z.enum(['code', '-code', 'name', '-name', 'createdAt', '-createdAt']).default('code'),
});
export type LocationListQuery = z.infer<typeof LocationListQuery>;

export const CreateLocationRequest = z
  .object({
    code: Code,
    name: z.string().trim().min(2).max(120),
    type: LocationType,
    storeId: Uuid.nullable().optional(),
    parentId: Uuid.nullable().optional(),
    address: Address.nullable().optional(),
  })
  .openapi('CreateLocationRequest');
export type CreateLocationRequest = z.infer<typeof CreateLocationRequest>;

export const UpdateLocationRequest = z
  .object({
    version: Version,
    name: z.string().trim().min(2).max(120).optional(),
    status: ActiveStatus.optional(),
    address: Address.nullable().optional(),
  })
  .openapi('UpdateLocationRequest');
export type UpdateLocationRequest = z.infer<typeof UpdateLocationRequest>;

// ---------- Members & invitations ----------
export const MemberStatus = z.enum(['active', 'suspended']);
export const Member = z
  .object({
    id: Uuid,
    user: UserSummary,
    status: MemberStatus,
    roles: z.array(RoleRef),
    locationScope: z.array(Uuid).nullable(),
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('Member');
export type Member = z.infer<typeof Member>;
export const MemberPage = pageOf(Member).openapi('MemberPage');
export const MemberListQuery = PageQuery.extend({
  q: z.string().trim().max(100).optional(),
  status: MemberStatus.optional(),
  roleId: Uuid.optional(),
});
export type MemberListQuery = z.infer<typeof MemberListQuery>;

export const UpdateMemberRequest = z
  .object({
    version: Version,
    roleIds: z.array(Uuid).min(1, 'Assign at least one role').max(20).optional(),
    status: MemberStatus.optional(),
    /** null = all locations. */
    locationScope: z.array(Uuid).max(200).nullable().optional(),
  })
  .openapi('UpdateMemberRequest');
export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequest>;

export const InvitationStatus = z.enum(['pending', 'accepted', 'revoked', 'expired']);
export const Invitation = z
  .object({
    id: Uuid,
    email: z.string(),
    status: InvitationStatus,
    roles: z.array(RoleRef),
    locationScope: z.array(Uuid).nullable(),
    expiresAt: Timestamp,
    createdAt: Timestamp,
    invitedBy: z.object({ id: Uuid, email: z.string() }).nullable(),
  })
  .openapi('Invitation');
export type Invitation = z.infer<typeof Invitation>;
export const InvitationPage = pageOf(Invitation).openapi('InvitationPage');
export const InvitationListQuery = PageQuery.extend({ status: InvitationStatus.optional() });

export const CreateInvitationRequest = z
  .object({
    email: Email,
    roleIds: z.array(Uuid).min(1, 'Assign at least one role').max(20),
    locationScope: z.array(Uuid).max(200).nullable().optional(),
  })
  .openapi('CreateInvitationRequest');
export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequest>;

export const CreateInvitationResponse = z
  .object({
    invitation: Invitation,
    /** Shown once. No email is sent until a notification connector exists (ADR-010). */
    inviteUrl: z.string(),
  })
  .openapi('CreateInvitationResponse');
export type CreateInvitationResponse = z.infer<typeof CreateInvitationResponse>;

// ---------- Roles ----------
export const Role = z
  .object({
    id: Uuid,
    key: z.string(),
    name: z.string(),
    description: z.string(),
    isSystem: z.boolean(),
    permissions: z.array(z.string()),
    memberCount: z.number().int(),
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('Role');
export type Role = z.infer<typeof Role>;
export const RoleList = z.object({ items: z.array(Role) }).openapi('RoleList');

export const CreateRoleRequest = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(300).default(''),
    permissions: z.array(z.string()).max(200),
  })
  .openapi('CreateRoleRequest');
export type CreateRoleRequest = z.infer<typeof CreateRoleRequest>;

export const UpdateRoleRequest = z
  .object({
    version: Version,
    name: z.string().trim().min(2).max(80).optional(),
    description: z.string().trim().max(300).optional(),
    permissions: z.array(z.string()).max(200).optional(),
  })
  .openapi('UpdateRoleRequest');
export type UpdateRoleRequest = z.infer<typeof UpdateRoleRequest>;

export const PermissionCatalog = z
  .object({
    items: z.array(z.object({ key: z.string(), group: z.string(), label: z.string(), phase: z.number().int() })),
  })
  .openapi('PermissionCatalog');
export type PermissionCatalog = z.infer<typeof PermissionCatalog>;
