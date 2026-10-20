import { SupportSessionInfo } from './launch';
import { Email, Timestamp, Uuid } from '../common';
import { PLATFORM_ROLE_KEYS, type PlatformRole } from '../permissions';
import { PRESET_KEYS } from '../features';
import { z } from '../z';

/** Session audiences. Buyers sign in through their B2B portal (/v1/storefront/b2b/auth), never /v1/auth. */
export const Audience = z.enum(['merchant', 'platform', 'buyer']);
export const StaffAudience = z.enum(['merchant', 'platform']);
export type Audience = z.infer<typeof Audience>;

export const PASSWORD_MIN = 12;
export const Password = z
  .string()
  .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters`)
  .max(128, 'Password must be at most 128 characters');

export const LoginRequest = z
  .object({
    email: Email,
    // Login accepts any non-empty password; policy applies when setting one.
    password: z.string().min(1).max(128),
    audience: StaffAudience,
  })
  .openapi('LoginRequest');
export type LoginRequest = z.infer<typeof LoginRequest>;

export const UserSummary = z
  .object({ id: Uuid, email: z.string(), displayName: z.string() })
  .openapi('UserSummary');
export type UserSummary = z.infer<typeof UserSummary>;

export const RoleRef = z.object({ id: Uuid, key: z.string(), name: z.string() }).openapi('RoleRef');
export type RoleRef = z.infer<typeof RoleRef>;

export const MembershipSummary = z
  .object({
    membershipId: Uuid,
    tenantId: Uuid,
    tenantSlug: z.string(),
    tenantName: z.string(),
    tenantStatus: z.enum(['provisioning', 'active', 'suspended']),
    preset: z.enum(PRESET_KEYS as [string, ...string[]]),
    isDemo: z.boolean(),
    roles: z.array(RoleRef),
  })
  .openapi('MembershipSummary');
export type MembershipSummary = z.infer<typeof MembershipSummary>;

export const MeResponse = z
  .object({
    user: UserSummary,
    audience: Audience,
    sessionExpiresAt: Timestamp,
    memberships: z.array(MembershipSummary),
    platformRole: z.enum(PLATFORM_ROLE_KEYS as [PlatformRole, ...PlatformRole[]]).nullable(),
    platformPermissions: z.array(z.string()),
    /** Phase 12: present only for a read-only platform support session. */
    support: SupportSessionInfo.nullable().default(null),
  })
  .openapi('MeResponse');
export type MeResponse = z.infer<typeof MeResponse>;

export const InvitationPreviewRequest = z.object({ token: z.string().min(20).max(200) }).openapi('InvitationPreviewRequest');
export const InvitationPreviewResponse = z
  .object({
    email: z.string(),
    tenantName: z.string(),
    roles: z.array(z.string()),
    expiresAt: Timestamp,
    userExists: z.boolean(),
  })
  .openapi('InvitationPreviewResponse');
export type InvitationPreviewResponse = z.infer<typeof InvitationPreviewResponse>;

export const AcceptInvitationRequest = z
  .object({
    token: z.string().min(20).max(200),
    /** Required when the invited email has no account yet. */
    displayName: z.string().trim().min(1).max(120).optional(),
    /** New password for a new account, or current password to confirm an existing account. */
    password: z.string().min(1).max(128),
  })
  .openapi('AcceptInvitationRequest');
export type AcceptInvitationRequest = z.infer<typeof AcceptInvitationRequest>;

export const AcceptInvitationResponse = z
  .object({ tenantId: Uuid, email: z.string(), accountCreated: z.boolean() })
  .openapi('AcceptInvitationResponse');
