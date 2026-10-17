import { Inject, Injectable } from '@nestjs/common';
import {
  FEATURE_KEYS,
  FEATURES,
  PRESETS,
  PRESET_KEYS,
  type CreateTenantRequest,
  type CreateTenantResponse,
  type EntitlementsResponse,
  type FeatureEntitlement,
  type FeatureKey,
  type Page,
  type PresetCatalogResponse,
  type PresetKey,
  type TenantDetail,
  type TenantListQuery,
  type TenantStatusChangeRequest,
  type TenantSummary,
  type UpdateEntitlementsRequest,
  type UpdateTenantRequest,
} from '@uc/contracts';
import {
  channels,
  diff,
  enqueueEvent,
  generateToken,
  invitations,
  locations,
  memberships,
  provisionTenantRecords,
  sha256,
  stores,
  tenantEntitlements,
  tenants,
  writeAudit,
  type Tx,
} from '@uc/db';
import { and, asc, count, desc, eq, gt, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { decodeCursor, paginate } from '../../common/cursor';
import { AppError, Errors } from '../../common/errors';
import { iso, likePattern } from '../../common/mappers';
import type { AuthState, RequestMeta } from '../../common/request';
import { DbService } from '../../db/db.service';

type TenantRow = typeof tenants.$inferSelect;

// Explicitly qualified: Drizzle renders `${tenants.id}` unqualified in single-table queries, which inside this
// subquery would bind to m.id instead of the outer tenant row.
const memberCountSql = sql<number>`(select count(*)::int from ${memberships} m where m.tenant_id = "tenants"."id" and m.status = 'active')`;

@Injectable()
export class PlatformTenantsService {
  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  presets(): PresetCatalogResponse {
    return {
      presets: PRESET_KEYS.map((key) => ({
        key,
        label: PRESETS[key].label,
        features: [...PRESETS[key].features],
      })),
      features: FEATURE_KEYS.map((key) => ({ key, ...FEATURES[key] })),
    };
  }

  private toSummary(row: TenantRow, memberCount: number): TenantSummary {
    return {
      id: row.id,
      slug: row.slug,
      displayName: row.displayName,
      legalName: row.legalName,
      status: row.status,
      preset: row.preset as PresetKey,
      countryCode: row.countryCode,
      defaultCurrency: row.defaultCurrency,
      timezone: row.timezone,
      defaultLocale: row.defaultLocale,
      isDemo: row.isDemo,
      version: row.version,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      memberCount,
    };
  }

  async list(query: TenantListQuery): Promise<Page<TenantSummary>> {
    const descending = query.sort.startsWith('-');
    const byName = query.sort.endsWith('displayName');
    const column = byName ? tenants.displayName : tenants.createdAt;
    const cursor = decodeCursor(query.cursor);
    const where: (SQL | undefined)[] = [];
    if (query.q) {
      const p = likePattern(query.q);
      where.push(or(ilike(tenants.displayName, p), ilike(tenants.slug, p), ilike(tenants.legalName, p)));
    }
    if (query.status) where.push(eq(tenants.status, query.status));
    if (query.preset) where.push(eq(tenants.preset, query.preset));
    if (cursor) {
      const value = byName ? String(cursor.sortValue) : new Date(String(cursor.sortValue));
      const cmp = descending ? lt : gt;
      where.push(or(cmp(column, value), and(eq(column, value), cmp(tenants.id, cursor.id))));
    }
    const rows = await this.db.system((tx) =>
      tx
        .select({ t: tenants, memberCount: memberCountSql })
        .from(tenants)
        .where(and(...where))
        .orderBy(...(descending ? [desc(column), desc(tenants.id)] : [asc(column), asc(tenants.id)]))
        .limit(query.limit + 1),
    );
    const page = paginate(
      rows.map((r) => ({ id: r.t.id, ...r })),
      query.limit,
      (r) => (byName ? r.t.displayName : r.t.createdAt.toISOString()),
    );
    return { items: page.items.map((r) => this.toSummary(r.t, r.memberCount)), nextCursor: page.nextCursor };
  }

  private async entitlements(tx: Tx, tenant: TenantRow): Promise<FeatureEntitlement[]> {
    const overrides = await tx
      .select()
      .from(tenantEntitlements)
      .where(eq(tenantEntitlements.tenantId, tenant.id));
    const defaults = new Set<FeatureKey>(PRESETS[tenant.preset as PresetKey].features);
    return FEATURE_KEYS.map((key) => {
      const override = overrides.find((o) => o.featureKey === key)?.enabled ?? null;
      const presetDefault = defaults.has(key);
      return { key, ...FEATURES[key], presetDefault, override, effective: override ?? presetDefault };
    });
  }

  private async detail(tx: Tx, id: string): Promise<TenantDetail> {
    const [row] = await tx
      .select({ t: tenants, memberCount: memberCountSql })
      .from(tenants)
      .where(eq(tenants.id, id));
    if (!row) throw Errors.notFound('Tenant');
    const n = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
    return {
      ...this.toSummary(row.t, row.memberCount),
      contactEmail: row.t.contactEmail,
      contactPhone: row.t.contactPhone,
      suspendedReason: row.t.suspendedReason,
      counts: {
        stores: await n(tx.select({ n: count() }).from(stores).where(eq(stores.tenantId, id))),
        channels: await n(tx.select({ n: count() }).from(channels).where(eq(channels.tenantId, id))),
        locations: await n(tx.select({ n: count() }).from(locations).where(eq(locations.tenantId, id))),
        activeMembers: row.memberCount,
        pendingInvitations: await n(
          tx
            .select({ n: count() })
            .from(invitations)
            .where(
              and(
                eq(invitations.tenantId, id),
                eq(invitations.status, 'pending'),
                gt(invitations.expiresAt, new Date()),
              ),
            ),
        ),
      },
      entitlements: await this.entitlements(tx, row.t),
    };
  }

  get(id: string): Promise<TenantDetail> {
    return this.db.system((tx) => this.detail(tx, id));
  }

  private audit(
    tx: Tx,
    auth: AuthState,
    meta: RequestMeta,
    tenantId: string,
    action: string,
    values: Partial<{
      oldValues: Record<string, unknown> | null;
      newValues: Record<string, unknown> | null;
      reason: string;
    }>,
  ) {
    return writeAudit(tx, {
      tenantId,
      actorType: 'platform',
      actorUserId: auth.userId,
      action,
      entityType: 'tenant',
      entityId: tenantId,
      ...values,
      correlationId: meta.correlationId,
      ip: meta.ip,
    });
  }

  async create(
    auth: AuthState,
    input: CreateTenantRequest,
    meta: RequestMeta,
  ): Promise<CreateTenantResponse> {
    return this.db.system(async (tx) => {
      const provisioned = await provisionTenantRecords(tx, {
        slug: input.slug,
        displayName: input.displayName,
        legalName: input.legalName,
        preset: input.preset,
        countryCode: input.countryCode,
        defaultCurrency: input.defaultCurrency,
        timezone: input.timezone,
        defaultLocale: input.defaultLocale,
        contactEmail: input.contactEmail,
        isDemo: input.isDemo,
      });
      const tenantId = provisioned.tenant.id;
      const token = generateToken();
      const expiresAt = new Date(Date.now() + this.config.invitationTtlMs);
      await tx.insert(invitations).values({
        tenantId,
        email: input.ownerEmail,
        roleIds: [provisioned.rolesByKey.owner!.id],
        tokenHash: sha256(token),
        expiresAt,
        invitedBy: auth.userId,
      });
      await this.audit(tx, auth, meta, tenantId, 'tenant.provisioned', {
        newValues: { ...input, storeId: provisioned.storeId, channelIds: provisioned.channelIds },
      });
      await enqueueEvent(tx, {
        tenantId,
        eventType: 'TenantProvisioned',
        aggregateType: 'tenant',
        aggregateId: tenantId,
        aggregateVersion: provisioned.tenant.version,
        correlationId: meta.correlationId,
        payload: { slug: input.slug, preset: input.preset, isDemo: input.isDemo },
      });
      return {
        tenant: await this.detail(tx, tenantId),
        ownerInvitation: {
          email: input.ownerEmail,
          inviteUrl: `${this.config.MERCHANT_ADMIN_URL}/accept-invite#token=${token}`,
          expiresAt: iso(expiresAt),
        },
      };
    });
  }

  private async lock(tx: Tx, id: string, version: number): Promise<TenantRow> {
    const [row] = await tx.select().from(tenants).where(eq(tenants.id, id)).for('update');
    if (!row) throw Errors.notFound('Tenant');
    if (row.version !== version) throw Errors.versionConflict(row.version);
    return row;
  }

  async update(
    auth: AuthState,
    id: string,
    input: UpdateTenantRequest,
    meta: RequestMeta,
  ): Promise<TenantDetail> {
    return this.db.system(async (tx) => {
      const before = await this.lock(tx, id, input.version);
      const { version, ...changes } = input;
      const [after] = await tx
        .update(tenants)
        .set({ ...changes, version: version + 1, updatedAt: new Date() })
        .where(and(eq(tenants.id, id), eq(tenants.version, version)))
        .returning();
      if (!after) throw Errors.versionConflict();
      await this.audit(
        tx,
        auth,
        meta,
        id,
        'tenant.updated',
        diff(this.toSummary(before, 0), this.toSummary(after, 0)),
      );
      if (changes.preset && changes.preset !== before.preset) {
        await enqueueEvent(tx, {
          tenantId: id,
          eventType: 'TenantEntitlementsChanged',
          aggregateType: 'tenant',
          aggregateId: id,
          aggregateVersion: after.version,
          correlationId: meta.correlationId,
          payload: { preset: changes.preset },
        });
      }
      return this.detail(tx, id);
    });
  }

  async changeStatus(
    auth: AuthState,
    id: string,
    target: 'active' | 'suspended',
    input: TenantStatusChangeRequest,
    meta: RequestMeta,
  ): Promise<TenantDetail> {
    return this.db.system(async (tx) => {
      const before = await this.lock(tx, id, input.version);
      const allowedFrom = target === 'suspended' ? 'active' : 'suspended';
      if (before.status !== allowedFrom) {
        throw new AppError(
          409,
          'INVALID_STATE_TRANSITION',
          `Cannot ${target === 'suspended' ? 'suspend' : 'reactivate'} a tenant that is ${before.status}`,
        );
      }
      const [after] = await tx
        .update(tenants)
        .set({
          status: target,
          suspendedReason: target === 'suspended' ? input.reason : null,
          version: before.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, id))
        .returning();
      await this.audit(
        tx,
        auth,
        meta,
        id,
        target === 'suspended' ? 'tenant.suspended' : 'tenant.reactivated',
        {
          oldValues: { status: before.status },
          newValues: { status: target },
          reason: input.reason,
        },
      );
      await enqueueEvent(tx, {
        tenantId: id,
        eventType: target === 'suspended' ? 'TenantSuspended' : 'TenantReactivated',
        aggregateType: 'tenant',
        aggregateId: id,
        aggregateVersion: after!.version,
        correlationId: meta.correlationId,
        payload: { reason: input.reason },
      });
      return this.detail(tx, id);
    });
  }

  async getEntitlements(id: string): Promise<EntitlementsResponse> {
    return this.db.system(async (tx) => {
      const [row] = await tx.select().from(tenants).where(eq(tenants.id, id));
      if (!row) throw Errors.notFound('Tenant');
      return { preset: row.preset as PresetKey, features: await this.entitlements(tx, row) };
    });
  }

  async updateEntitlements(
    auth: AuthState,
    id: string,
    input: UpdateEntitlementsRequest,
    meta: RequestMeta,
  ): Promise<EntitlementsResponse> {
    return this.db.system(async (tx) => {
      const [row] = await tx.select().from(tenants).where(eq(tenants.id, id)).for('update');
      if (!row) throw Errors.notFound('Tenant');
      const before = await this.entitlements(tx, row);
      for (const [key, value] of Object.entries(input.overrides) as [FeatureKey, boolean | null][]) {
        if (value === null) {
          await tx
            .delete(tenantEntitlements)
            .where(and(eq(tenantEntitlements.tenantId, id), eq(tenantEntitlements.featureKey, key)));
        } else {
          await tx
            .insert(tenantEntitlements)
            .values({ tenantId: id, featureKey: key, enabled: value, updatedBy: auth.userId })
            .onConflictDoUpdate({
              target: [tenantEntitlements.tenantId, tenantEntitlements.featureKey],
              set: { enabled: value, updatedBy: auth.userId, updatedAt: new Date() },
            });
        }
      }
      const after = await this.entitlements(tx, row);
      const snapshot = (list: FeatureEntitlement[]) =>
        Object.fromEntries(list.map((f) => [f.key, f.effective]));
      await this.audit(tx, auth, meta, id, 'tenant.entitlements_changed', {
        ...diff(snapshot(before), snapshot(after)),
        reason: input.reason,
      });
      await enqueueEvent(tx, {
        tenantId: id,
        eventType: 'TenantEntitlementsChanged',
        aggregateType: 'tenant',
        aggregateId: id,
        aggregateVersion: row.version,
        correlationId: meta.correlationId,
        payload: { overrides: input.overrides },
      });
      return { preset: row.preset as PresetKey, features: after };
    });
  }
}
