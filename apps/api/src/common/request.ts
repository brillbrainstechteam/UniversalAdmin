import type { Audience, FeatureKey, TenantPermission, PlatformPermission, PlatformRole } from '@uc/contracts';
import type { Request } from 'express';

export interface AuthState {
  userId: string;
  email: string;
  displayName: string;
  sessionId: string;
  audience: Audience;
  sessionExpiresAt: Date;
  /** Phase 12: set for a read-only platform support session bound to one approved grant. */
  support?: { grantId: string; tenantId: string; expiresAt: Date };
}

export interface TenantState {
  tenantId: string;
  membershipId: string;
  permissions: ReadonlySet<TenantPermission>;
  features: readonly FeatureKey[];
  /** null = all locations */
  locationScope: readonly string[] | null;
  roleKeys: readonly string[];
  isOwner: boolean;
}

export interface PlatformState {
  role: PlatformRole;
  permissions: ReadonlySet<PlatformPermission>;
}

export interface AppRequest extends Request {
  correlationId: string;
  auth?: AuthState;
  tenant?: TenantState;
  platform?: PlatformState;
  /** Phase 11: set when the request authenticated with an API key (acts for the key's creator). */
  apiKey?: { id: string; tenantId: string; scopes: readonly string[] };
}

/** Request metadata passed into services for audit/outbox. */
export interface RequestMeta {
  correlationId: string;
  ip: string | null;
  userAgent: string | null;
}

export function metaOf(req: AppRequest): RequestMeta {
  const ua = req.headers['user-agent'];
  return {
    correlationId: req.correlationId,
    ip: req.ip ?? null,
    userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null,
  };
}
