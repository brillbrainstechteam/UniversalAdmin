import { Inject, Injectable } from '@nestjs/common';
import type {
  DecideSupportGrant,
  RequestSupportAccess,
  SupportGrant,
  SupportGrantStatus,
  SupportSessionStarted,
} from '@uc/contracts';
import {
  auditEvents,
  generateToken,
  sha256,
  staffNotifications,
  supportGrants,
  tenants,
  users,
  writeAudit,
  type Tx,
} from '@uc/db';
import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { Errors } from '../../common/errors';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';
import { RedisService } from '../../db/redis.service';
import { SessionService } from '../auth/session.service';

type GrantRow = typeof supportGrants.$inferSelect;
const decider = alias(users, 'decider');
const HANDOFF_PREFIX = 'support-handoff:';
const HANDOFF_TTL_SECONDS = 60;

function effectiveStatus(r: GrantRow, now = new Date()): SupportGrantStatus {
  if (r.status === 'approved' && r.expiresAt && r.expiresAt <= now) return 'expired';
  return r.status;
}

/**
 * Just-in-time support access (Phase 12, ADR-027): an operator asks with a reason, a merchant owner approves, only
 * the requesting operator can open the read-only session, and it ends at expiry or on revoke.
 */
@Injectable()
export class SupportService {
  constructor(
    private readonly db: DbService,
    private readonly sessions: SessionService,
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------- platform side

  async request(auth: AuthState, tenantId: string, body: RequestSupportAccess, meta: RequestMeta) {
    const [tenant] = await this.db.system((tx) =>
      tx.select({ status: tenants.status }).from(tenants).where(eq(tenants.id, tenantId)),
    );
    if (!tenant) throw Errors.notFound('Tenant');
    if (tenant.status !== 'active')
      throw Errors.conflict(
        'INVALID_STATE_TRANSITION',
        'Support access can be requested for active merchants only',
      );
    const id = await this.db.tenant(tenantId, async (tx) => {
      const [row] = await tx
        .insert(supportGrants)
        .values({
          tenantId,
          requestedBy: auth.userId,
          reason: body.reason,
          ticketRef: body.ticketRef ?? null,
          durationMinutes: body.durationMinutes,
        })
        .returning({ id: supportGrants.id });
      if (!row) throw new Error('support grant insert failed');
      await tx.insert(staffNotifications).values({
        tenantId,
        title: `Platform support asks for ${body.durationMinutes} minutes of read-only access`,
        body: `${auth.displayName} (${auth.email}): ${body.reason}`,
        link: '/settings/support',
        source: 'support',
      });
      await this.audit(tx, auth, tenantId, row.id, 'support.requested', meta, {
        reason: body.reason,
        ticketRef: body.ticketRef ?? null,
        durationMinutes: body.durationMinutes,
      });
      return row.id;
    });
    return this.get(tenantId, id);
  }

  async listPlatform(tenantId?: string): Promise<{ items: SupportGrant[] }> {
    return this.db.system(async (tx) => ({
      items: await this.query(tx, tenantId ? eq(supportGrants.tenantId, tenantId) : undefined),
    }));
  }

  /**
   * Issues a one-time, 60-second handoff code for the merchant admin (which may live on another origin). Only the
   * operator who asked may start the session, and only while the grant is approved.
   */
  async start(auth: AuthState, grantId: string, meta: RequestMeta): Promise<SupportSessionStarted> {
    const grant = await this.findSystem(grantId);
    this.assertStartable(grant, auth.userId);
    const code = generateToken();
    await this.redis.client.set(
      `${HANDOFF_PREFIX}${sha256(code)}`,
      JSON.stringify({ grantId, userId: auth.userId }),
      'EX',
      HANDOFF_TTL_SECONDS,
    );
    await this.db.tenant(grant.tenantId, (tx) =>
      this.audit(tx, auth, grant.tenantId, grantId, 'support.handoff_issued', meta, null),
    );
    return {
      tenantId: grant.tenantId,
      expiresAt: grant.expiresAt!.toISOString(),
      merchantAdminUrl: `${this.config.MERCHANT_ADMIN_URL}/support/start#code=${code}`,
    };
  }

  /** Redeems a handoff code (single use) into a read-only merchant session that ends with the grant. */
  async redeem(
    code: string,
    meta: RequestMeta,
  ): Promise<{ token: string; tenantId: string; expiresAt: Date }> {
    const raw = await this.redis.client.getdel(`${HANDOFF_PREFIX}${sha256(code)}`);
    if (!raw) throw Errors.unauthenticated('This support link has expired or was already used. Start again.');
    const { grantId, userId } = JSON.parse(raw) as { grantId: string; userId: string };
    const grant = await this.findSystem(grantId);
    this.assertStartable(grant, userId);
    const [user] = await this.db.system((tx) =>
      tx
        .select({ email: users.email, displayName: users.displayName, status: users.status })
        .from(users)
        .where(eq(users.id, userId)),
    );
    if (!user || user.status !== 'active') throw Errors.unauthenticated();
    const expiresAt = grant.expiresAt!;
    const session = await this.sessions.create(userId, 'merchant', meta, { grantId, expiresAt });
    await this.db.tenant(grant.tenantId, async (tx) => {
      await tx
        .update(supportGrants)
        .set({ startedAt: grant.startedAt ?? new Date() })
        .where(eq(supportGrants.id, grantId));
      await writeAudit(tx, {
        tenantId: grant.tenantId,
        actorType: 'platform',
        actorUserId: userId,
        action: 'support.session_started',
        entityType: 'support_grant',
        entityId: grantId,
        newValues: { sessionId: session.sessionId, expiresAt: session.expiresAt.toISOString() },
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
    });
    return { token: session.token, tenantId: grant.tenantId, expiresAt: session.expiresAt };
  }

  private assertStartable(grant: GrantRow, userId: string): void {
    if (grant.requestedBy !== userId)
      throw Errors.forbidden('Only the operator who requested this access can start it');
    const status = effectiveStatus(grant);
    if (status !== 'approved')
      throw Errors.conflict('INVALID_STATE_TRANSITION', `This support request is ${status}, not approved`);
  }

  /** The operator may end their own access early. */
  async revokeByOperator(auth: AuthState, grantId: string, meta: RequestMeta): Promise<SupportGrant> {
    const grant = await this.findSystem(grantId);
    if (grant.requestedBy !== auth.userId)
      throw Errors.forbidden('Only the operator who requested this access can end it here');
    return this.revoke(auth, grant, meta, 'platform');
  }

  // ---------------------------------------------------------------- merchant side

  async listTenant(ctx: TenantState): Promise<{ items: SupportGrant[] }> {
    return this.db.tenant(ctx.tenantId, async (tx) => ({
      items: await this.query(tx, eq(supportGrants.tenantId, ctx.tenantId)),
    }));
  }

  async approve(auth: AuthState, ctx: TenantState, id: string, body: DecideSupportGrant, meta: RequestMeta) {
    return this.decide(auth, ctx, id, body, meta, 'approved');
  }

  async deny(auth: AuthState, ctx: TenantState, id: string, body: DecideSupportGrant, meta: RequestMeta) {
    return this.decide(auth, ctx, id, body, meta, 'denied');
  }

  async revokeByMerchant(auth: AuthState, ctx: TenantState, id: string, meta: RequestMeta) {
    const grant = await this.db.tenant(ctx.tenantId, async (tx) => {
      const [g] = await tx
        .select()
        .from(supportGrants)
        .where(and(eq(supportGrants.tenantId, ctx.tenantId), eq(supportGrants.id, id)));
      return g;
    });
    if (!grant) throw Errors.notFound('Support request');
    return this.revoke(auth, grant, meta, 'user');
  }

  private async decide(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    body: DecideSupportGrant,
    meta: RequestMeta,
    to: 'approved' | 'denied',
  ): Promise<SupportGrant> {
    await this.db.tenant(ctx.tenantId, async (tx) => {
      const [g] = await tx
        .select()
        .from(supportGrants)
        .where(and(eq(supportGrants.tenantId, ctx.tenantId), eq(supportGrants.id, id)))
        .for('update');
      if (!g) throw Errors.notFound('Support request');
      if (g.version !== body.version) throw Errors.versionConflict(g.version);
      if (g.status !== 'requested')
        throw Errors.conflict('INVALID_STATE_TRANSITION', `This support request is already ${g.status}`);
      if (g.requestedBy === auth.userId)
        throw Errors.forbidden('You cannot approve or deny your own support request');
      const now = new Date();
      await tx
        .update(supportGrants)
        .set({
          status: to,
          decidedBy: auth.userId,
          decidedAt: now,
          decisionNote: body.note ?? null,
          expiresAt: to === 'approved' ? new Date(now.getTime() + g.durationMinutes * 60_000) : null,
          version: g.version + 1,
        })
        .where(eq(supportGrants.id, id));
      await this.audit(
        tx,
        auth,
        ctx.tenantId,
        id,
        `support.${to}`,
        meta,
        { note: body.note ?? null },
        'user',
      );
    });
    return this.get(ctx.tenantId, id);
  }

  private async revoke(
    auth: AuthState,
    grant: GrantRow,
    meta: RequestMeta,
    actorType: 'user' | 'platform',
  ): Promise<SupportGrant> {
    const status = effectiveStatus(grant);
    if (status !== 'approved' && status !== 'requested')
      throw Errors.conflict('INVALID_STATE_TRANSITION', `This support request is already ${status}`);
    await this.db.tenant(grant.tenantId, async (tx) => {
      const [updated] = await tx
        .update(supportGrants)
        .set({ status: 'revoked', revokedBy: auth.userId, revokedAt: new Date(), version: grant.version + 1 })
        .where(and(eq(supportGrants.id, grant.id), eq(supportGrants.version, grant.version)))
        .returning({ id: supportGrants.id });
      if (!updated) throw Errors.versionConflict();
      await this.audit(tx, auth, grant.tenantId, grant.id, 'support.revoked', meta, null, actorType);
    });
    // Sessions end immediately (they are also refused on the next request because the grant is no longer approved).
    await this.sessions.revokeForGrant(grant.id);
    return this.get(grant.tenantId, grant.id);
  }

  // ---------------------------------------------------------------- helpers

  private async findSystem(id: string): Promise<GrantRow> {
    const [g] = await this.db.system((tx) => tx.select().from(supportGrants).where(eq(supportGrants.id, id)));
    if (!g) throw Errors.notFound('Support request');
    return g;
  }

  private async get(tenantId: string, id: string): Promise<SupportGrant> {
    const [g] = await this.db.tenant(tenantId, (tx) => this.query(tx, eq(supportGrants.id, id)));
    if (!g) throw Errors.notFound('Support request');
    return g;
  }

  private async query(tx: Tx, where: SQL | undefined): Promise<SupportGrant[]> {
    const rows = await tx
      .select({
        g: supportGrants,
        tenantName: tenants.displayName,
        reqId: users.id,
        reqEmail: users.email,
        reqName: users.displayName,
        deciderName: decider.displayName,
      })
      .from(supportGrants)
      .innerJoin(tenants, eq(tenants.id, supportGrants.tenantId))
      .innerJoin(users, eq(users.id, supportGrants.requestedBy))
      .leftJoin(decider, eq(decider.id, supportGrants.decidedBy))
      .where(where)
      .orderBy(desc(supportGrants.createdAt))
      .limit(200);
    const ids = rows.map((r) => r.g.id);
    const counts = ids.length
      ? await tx
          .select({ id: auditEvents.entityId, n: count() })
          .from(auditEvents)
          .where(and(eq(auditEvents.action, 'support.request'), inArray(auditEvents.entityId, ids)))
          .groupBy(auditEvents.entityId)
      : [];
    const byId = new Map(counts.map((c) => [c.id, Number(c.n)]));
    const now = new Date();
    return rows.map(({ g, ...r }) => ({
      id: g.id,
      tenantId: g.tenantId,
      tenantName: r.tenantName,
      requestedBy: { id: r.reqId, email: r.reqEmail, displayName: r.reqName },
      reason: g.reason,
      ticketRef: g.ticketRef,
      durationMinutes: g.durationMinutes,
      status: effectiveStatus(g, now),
      decidedBy: r.deciderName ?? null,
      decidedAt: g.decidedAt?.toISOString() ?? null,
      decisionNote: g.decisionNote,
      expiresAt: g.expiresAt?.toISOString() ?? null,
      startedAt: g.startedAt?.toISOString() ?? null,
      revokedAt: g.revokedAt?.toISOString() ?? null,
      requestCount: byId.get(g.id) ?? 0,
      version: g.version,
      createdAt: g.createdAt.toISOString(),
    }));
  }

  private audit(
    tx: Tx,
    auth: AuthState,
    tenantId: string,
    grantId: string,
    action: string,
    meta: RequestMeta,
    values: Record<string, unknown> | null,
    actorType: 'user' | 'platform' = 'platform',
  ) {
    return writeAudit(tx, {
      tenantId,
      actorType,
      actorUserId: auth.userId,
      action,
      entityType: 'support_grant',
      entityId: grantId,
      newValues: values,
      correlationId: meta.correlationId,
      ip: meta.ip,
    });
  }
}
