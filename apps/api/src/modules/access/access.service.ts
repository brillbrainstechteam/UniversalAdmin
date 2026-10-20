import { Injectable } from '@nestjs/common';
import {
  effectiveFeatures,
  isTenantPermission,
  PLATFORM_ROLES,
  SYSTEM_ROLES,
  type FeatureKey,
  type FeatureOverrides,
  type PlatformPermission,
  type PlatformRole,
  type PresetKey,
  type TenantPermission,
} from '@uc/contracts';
import {
  membershipRoles,
  memberships,
  mfaFactors,
  platformAdmins,
  roles,
  tenantEntitlements,
  tenants,
  writeAudit,
  type Tx,
} from '@uc/db';
import { and, eq } from 'drizzle-orm';
import { DbService } from '../../db/db.service';
import { AppError } from '../../common/errors';
import type { AppRequest, PlatformState, TenantState } from '../../common/request';

export async function loadFeatures(tx: Tx, tenantId: string, preset: PresetKey): Promise<FeatureKey[]> {
  const overrides = await tx
    .select({ key: tenantEntitlements.featureKey, enabled: tenantEntitlements.enabled })
    .from(tenantEntitlements)
    .where(eq(tenantEntitlements.tenantId, tenantId));
  const map: FeatureOverrides = {};
  for (const o of overrides) map[o.key as FeatureKey] = o.enabled;
  return effectiveFeatures(preset, map);
}

/** Resolves who may do what inside a tenant (ADR-003/005). Fails closed. */
@Injectable()
export class AccessService {
  constructor(private readonly db: DbService) {}

  async resolveTenant(userId: string, tenantId: string): Promise<TenantState> {
    const [tenant] = await this.db.system((tx) =>
      tx
        .select({
          id: tenants.id,
          status: tenants.status,
          preset: tenants.preset,
          requireMfa: tenants.requireMfaForAdmins,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId)),
    );
    // Unknown tenant and non-member are indistinguishable to the caller.
    if (!tenant) throw new AppError(403, 'TENANT_ACCESS_DENIED', 'You are not a member of this merchant');

    return this.db.tenant(tenantId, async (tx) => {
      const [membership] = await tx
        .select()
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));
      if (!membership || membership.status !== 'active') {
        throw new AppError(403, 'TENANT_ACCESS_DENIED', 'You are not a member of this merchant');
      }
      if (tenant.status !== 'active') {
        throw new AppError(
          403,
          'TENANT_SUSPENDED',
          'This merchant account is suspended. Contact platform support.',
        );
      }
      const roleRows = await tx
        .select({ key: roles.key, permissions: roles.permissions })
        .from(membershipRoles)
        .innerJoin(
          roles,
          and(eq(roles.id, membershipRoles.roleId), eq(roles.tenantId, membershipRoles.tenantId)),
        )
        .where(and(eq(membershipRoles.tenantId, tenantId), eq(membershipRoles.membershipId, membership.id)));

      // Phase 11: owners/admins of a tenant that requires two-step verification must have it enrolled.
      if (tenant.requireMfa && roleRows.some((r) => r.key === 'owner' || r.key === 'admin')) {
        const [factor] = await this.db.system((sys) =>
          sys
            .select({ confirmedAt: mfaFactors.confirmedAt })
            .from(mfaFactors)
            .where(eq(mfaFactors.userId, userId)),
        );
        if (!factor?.confirmedAt)
          throw new AppError(
            403,
            'MFA_ENROLMENT_REQUIRED',
            'This merchant requires two-step verification for owners and admins. Turn it on in Account security.',
          );
      }
      const permissions = new Set<TenantPermission>();
      for (const role of roleRows)
        for (const p of role.permissions) if (isTenantPermission(p)) permissions.add(p);

      return {
        tenantId,
        membershipId: membership.id,
        permissions,
        features: await loadFeatures(tx, tenantId, tenant.preset),
        locationScope: membership.locationScope ?? null,
        roleKeys: roleRows.map((r) => r.key),
        isOwner: roleRows.some((r) => r.key === 'owner'),
      };
    });
  }

  /**
   * Phase 12 support session: the merchant's `viewer` permissions (read-only, no customer personal data, no audit
   * log), never more. The grant was checked when the session was resolved.
   */
  async resolveSupport(grantId: string, tenantId: string): Promise<TenantState> {
    const [tenant] = await this.db.system((tx) =>
      tx
        .select({ status: tenants.status, preset: tenants.preset })
        .from(tenants)
        .where(eq(tenants.id, tenantId)),
    );
    if (!tenant) throw new AppError(403, 'TENANT_ACCESS_DENIED', 'You are not a member of this merchant');
    if (tenant.status !== 'active')
      throw new AppError(
        403,
        'TENANT_SUSPENDED',
        'This merchant account is suspended. Contact platform support.',
      );
    const permissions = new Set<TenantPermission>(
      SYSTEM_ROLES.viewer!.permissions.filter((p) => p.endsWith('.read')),
    );
    return {
      tenantId,
      membershipId: grantId,
      permissions,
      features: await this.db.tenant(tenantId, (tx) => loadFeatures(tx, tenantId, tenant.preset)),
      locationScope: null,
      roleKeys: ['support'],
      isOwner: false,
    };
  }

  /** Every request made in a support session is recorded in the merchant's audit log. */
  async auditSupportRequest(
    userId: string,
    grantId: string,
    tenantId: string,
    req: AppRequest,
  ): Promise<void> {
    await this.db.tenant(tenantId, (tx) =>
      writeAudit(tx, {
        tenantId,
        actorType: 'platform',
        actorUserId: userId,
        action: 'support.request',
        entityType: 'support_grant',
        entityId: grantId,
        newValues: { method: req.method, path: req.path },
        correlationId: req.correlationId,
        ip: req.ip ?? null,
      }),
    );
  }

  async resolvePlatform(userId: string): Promise<PlatformState | null> {
    const [row] = await this.db.system((tx) =>
      tx.select().from(platformAdmins).where(eq(platformAdmins.userId, userId)),
    );
    if (!row || row.status !== 'active') return null;
    const role = row.role as PlatformRole;
    return { role, permissions: new Set<PlatformPermission>(PLATFORM_ROLES[role].permissions) };
  }
}
