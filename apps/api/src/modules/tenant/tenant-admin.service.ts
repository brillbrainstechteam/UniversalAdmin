import { Injectable } from '@nestjs/common';
import {
  computeNav,
  type AdminContext,
  type HomeSummary,
  type PresetKey,
  type TenantSettings,
  type UpdateTenantSettingsRequest,
} from '@uc/contracts';
import {
  auditEvents,
  channelDomains,
  channels,
  diff,
  invitations,
  locations,
  membershipRoles,
  memberships,
  roles,
  stores,
  supportGrants,
  tenants,
  users,
  writeAudit,
} from '@uc/db';
import { and, count, desc, eq, gt } from 'drizzle-orm';
import { Errors } from '../../common/errors';
import { iso, toAuditEvent } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';

type TenantRow = typeof tenants.$inferSelect;

function toSettings(t: TenantRow): TenantSettings {
  return {
    displayName: t.displayName,
    legalName: t.legalName,
    contactEmail: t.contactEmail,
    contactPhone: t.contactPhone,
    countryCode: t.countryCode,
    defaultCurrency: t.defaultCurrency,
    timezone: t.timezone,
    defaultLocale: t.defaultLocale,
    version: t.version,
    updatedAt: iso(t.updatedAt),
  };
}

@Injectable()
export class TenantAdminService {
  constructor(private readonly db: DbService) {}

  async context(auth: AuthState, ctx: TenantState): Promise<AdminContext> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, ctx.tenantId));
      if (!tenant) throw Errors.notFound('Tenant');
      const roleRows = await tx
        .select({ id: roles.id, key: roles.key, name: roles.name })
        .from(membershipRoles)
        .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
        .where(
          and(eq(membershipRoles.tenantId, ctx.tenantId), eq(membershipRoles.membershipId, ctx.membershipId)),
        );
      const permissions = [...ctx.permissions].sort();
      // Phase 12: a support session has no membership; it shows a read-only "Support" role and a banner.
      let support: AdminContext['support'] = null;
      if (auth.support) {
        const [grant] = await tx
          .select({ reason: supportGrants.reason })
          .from(supportGrants)
          .where(eq(supportGrants.id, auth.support.grantId));
        roleRows.splice(0, roleRows.length, {
          id: auth.support.grantId,
          key: 'support',
          name: 'Support (read-only)',
        });
        support = {
          grantId: auth.support.grantId,
          tenantId: tenant.id,
          tenantName: tenant.displayName,
          reason: grant?.reason ?? '',
          expiresAt: auth.support.expiresAt.toISOString(),
          readOnly: true,
        };
      }
      return {
        tenant: {
          id: tenant.id,
          slug: tenant.slug,
          displayName: tenant.displayName,
          legalName: tenant.legalName,
          status: tenant.status,
          preset: tenant.preset as PresetKey,
          isDemo: tenant.isDemo,
          countryCode: tenant.countryCode,
          defaultCurrency: tenant.defaultCurrency,
          timezone: tenant.timezone,
          defaultLocale: tenant.defaultLocale,
        },
        user: { id: auth.userId, email: auth.email, displayName: auth.displayName },
        membership: {
          id: ctx.membershipId,
          roles: roleRows,
          locationScope: ctx.locationScope ? [...ctx.locationScope] : null,
        },
        permissions,
        features: [...ctx.features],
        nav: computeNav(ctx.features, permissions),
        support,
      };
    });
  }

  /** All numbers are live aggregates over tenant-scoped rows (no cached or invented metrics). */
  async home(ctx: TenantState): Promise<HomeSummary> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const t = ctx.tenantId;
      const one = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
      const [
        storesN,
        channelsN,
        activeChannelsN,
        locationsN,
        membersN,
        pendingN,
        verifiedDomainsN,
        customRolesN,
      ] = await Promise.all([
        one(tx.select({ n: count() }).from(stores).where(eq(stores.tenantId, t))),
        one(tx.select({ n: count() }).from(channels).where(eq(channels.tenantId, t))),
        one(
          tx
            .select({ n: count() })
            .from(channels)
            .where(and(eq(channels.tenantId, t), eq(channels.status, 'active'))),
        ),
        one(tx.select({ n: count() }).from(locations).where(eq(locations.tenantId, t))),
        one(
          tx
            .select({ n: count() })
            .from(memberships)
            .where(and(eq(memberships.tenantId, t), eq(memberships.status, 'active'))),
        ),
        one(
          tx
            .select({ n: count() })
            .from(invitations)
            .where(
              and(
                eq(invitations.tenantId, t),
                eq(invitations.status, 'pending'),
                gt(invitations.expiresAt, new Date()),
              ),
            ),
        ),
        one(
          tx
            .select({ n: count() })
            .from(channelDomains)
            .where(and(eq(channelDomains.tenantId, t), eq(channelDomains.status, 'verified'))),
        ),
        one(
          tx
            .select({ n: count() })
            .from(roles)
            .where(and(eq(roles.tenantId, t), eq(roles.isSystem, false))),
        ),
      ]);
      const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, t));
      const recent = ctx.permissions.has('audit.read')
        ? await tx
            .select({ event: auditEvents, email: users.email })
            .from(auditEvents)
            .leftJoin(users, eq(users.id, auditEvents.actorUserId))
            .where(eq(auditEvents.tenantId, t))
            .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
            .limit(8)
        : [];
      return {
        counts: {
          stores: storesN,
          channels: channelsN,
          activeChannels: activeChannelsN,
          locations: locationsN,
          activeMembers: membersN,
          pendingInvitations: pendingN,
        },
        setupChecklist: [
          {
            key: 'business-profile',
            label: 'Add business contact details',
            done: Boolean(tenant?.contactEmail && tenant.contactPhone),
            path: '/settings/general',
          },
          {
            key: 'locations',
            label: 'Add a branch or warehouse beyond the default',
            done: locationsN > 1,
            path: '/settings/locations',
          },
          {
            key: 'staff',
            label: 'Invite at least one staff member',
            done: membersN + pendingN > 1,
            path: '/settings/staff',
          },
          {
            key: 'roles',
            label: 'Review roles and permissions',
            done: customRolesN > 0 || membersN > 1,
            path: '/settings/roles',
          },
          {
            key: 'domain',
            label: 'Connect a verified storefront domain (available in Online Store, Phase 10)',
            done: verifiedDomainsN > 0,
            path: null,
          },
        ],
        recentActivity: recent.map((r) => toAuditEvent(r.event, r.email)),
        generatedAt: new Date().toISOString(),
      };
    });
  }

  async getSettings(ctx: TenantState): Promise<TenantSettings> {
    const [tenant] = await this.db.tenant(ctx.tenantId, (tx) =>
      tx.select().from(tenants).where(eq(tenants.id, ctx.tenantId)),
    );
    if (!tenant) throw Errors.notFound('Tenant');
    return toSettings(tenant);
  }

  async updateSettings(
    auth: AuthState,
    ctx: TenantState,
    input: UpdateTenantSettingsRequest,
    meta: RequestMeta,
  ): Promise<TenantSettings> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [before] = await tx.select().from(tenants).where(eq(tenants.id, ctx.tenantId)).for('update');
      if (!before) throw Errors.notFound('Tenant');
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      const { version: _v, ...changes } = input;
      const [after] = await tx
        .update(tenants)
        .set({ ...changes, version: before.version + 1, updatedAt: new Date() })
        .where(and(eq(tenants.id, ctx.tenantId), eq(tenants.version, input.version)))
        .returning();
      if (!after) throw Errors.versionConflict();
      const d = diff(toSettings(before), toSettings(after));
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: 'settings.general.updated',
        entityType: 'tenant',
        entityId: ctx.tenantId,
        ...d,
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return toSettings(after);
    });
  }
}
