import { Inject, Injectable } from '@nestjs/common';
import {
  Password,
  PLATFORM_ROLES,
  type AcceptInvitationRequest,
  type Audience,
  type InvitationPreviewResponse,
  type LoginRequest,
  type MeResponse,
  type MembershipSummary,
  type PlatformRole,
} from '@uc/contracts';
import {
  enqueueEvent,
  hashPassword,
  invitations,
  membershipRoles,
  memberships,
  platformAdmins,
  roles,
  sha256,
  tenants,
  users,
  verifyPassword,
  writeAudit,
  type Tx,
} from '@uc/db';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { DbService } from '../../db/db.service';
import { RedisService } from '../../db/redis.service';
import { AppError, Errors } from '../../common/errors';
import type { AuthState, RequestMeta } from '../../common/request';
import { SessionService } from './session.service';

// Pre-computed hash so unknown-email logins take as long as real ones (no account enumeration via timing).
let dummyHash: Promise<string> | undefined;

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async login(input: LoginRequest, meta: RequestMeta): Promise<{ token: string; me: MeResponse }> {
    const { perIp, perEmail, windowSeconds } = this.config.loginRateLimit;
    const ipOk = await this.redis.hit(`rl:login:ip:${meta.ip ?? 'unknown'}`, perIp, windowSeconds);
    const emailOk = await this.redis.hit(`rl:login:email:${input.email}`, perEmail, windowSeconds);
    if (!ipOk || !emailOk)
      throw new AppError(429, 'RATE_LIMITED', 'Too many sign-in attempts. Try again later.');

    const invalid = () => new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    const [user] = await this.db.system((tx) => tx.select().from(users).where(eq(users.email, input.email)));
    if (!user) {
      dummyHash ??= hashPassword('dummy-password-for-timing');
      await verifyPassword(await dummyHash, input.password);
      throw invalid();
    }

    const now = new Date();
    if (user.lockedUntil && user.lockedUntil > now) {
      throw new AppError(423, 'ACCOUNT_LOCKED', 'Account temporarily locked after repeated failed sign-ins', {
        lockedUntil: user.lockedUntil.toISOString(),
      });
    }

    const passwordOk = await verifyPassword(user.passwordHash, input.password);
    if (!passwordOk) {
      await this.db.system(async (tx) => {
        // Atomic increment so concurrent failures are all counted.
        const [counted] = await tx
          .update(users)
          .set({ failedLoginCount: sql`${users.failedLoginCount} + 1` })
          .where(eq(users.id, user.id))
          .returning({ failures: users.failedLoginCount });
        const failures = counted?.failures ?? 1;
        const lock = failures >= this.config.lockout.maxFailures;
        if (lock) {
          await tx
            .update(users)
            .set({ failedLoginCount: 0, lockedUntil: new Date(now.getTime() + this.config.lockout.lockMs) })
            .where(eq(users.id, user.id));
        }
        await writeAudit(tx, {
          tenantId: null,
          actorType: 'user',
          actorUserId: user.id,
          action: lock ? 'auth.account_locked' : 'auth.login_failed',
          entityType: 'user',
          entityId: user.id,
          newValues: { audience: input.audience, failures },
          correlationId: meta.correlationId,
          ip: meta.ip,
        });
      });
      throw invalid();
    }
    if (user.status !== 'active') throw new AppError(401, 'ACCOUNT_DISABLED', 'This account is disabled');

    if (input.audience === 'platform') {
      const [admin] = await this.db.system((tx) =>
        tx.select().from(platformAdmins).where(eq(platformAdmins.userId, user.id)),
      );
      if (!admin || admin.status !== 'active') {
        throw Errors.forbidden('This account is not a platform operator');
      }
    }

    await this.db.system(async (tx) => {
      await tx
        .update(users)
        .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now })
        .where(eq(users.id, user.id));
      await writeAudit(tx, {
        tenantId: null,
        actorType: input.audience === 'platform' ? 'platform' : 'user',
        actorUserId: user.id,
        action: 'auth.login',
        entityType: 'user',
        entityId: user.id,
        newValues: { audience: input.audience },
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
    });

    const session = await this.sessions.create(user.id, input.audience, meta);
    const me = await this.me({
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      sessionId: session.sessionId,
      audience: input.audience,
      sessionExpiresAt: session.expiresAt,
    });
    return { token: session.token, me };
  }

  async me(auth: AuthState): Promise<MeResponse> {
    return this.db.system(async (tx) => {
      const memberships = auth.audience === 'merchant' ? await this.membershipsOf(tx, auth.userId) : [];
      let platformRole: PlatformRole | null = null;
      if (auth.audience === 'platform') {
        const [admin] = await tx.select().from(platformAdmins).where(eq(platformAdmins.userId, auth.userId));
        platformRole = admin?.status === 'active' ? (admin.role as PlatformRole) : null;
      }
      return {
        user: { id: auth.userId, email: auth.email, displayName: auth.displayName },
        audience: auth.audience,
        sessionExpiresAt: auth.sessionExpiresAt.toISOString(),
        memberships,
        platformRole,
        platformPermissions: platformRole ? [...PLATFORM_ROLES[platformRole].permissions] : [],
      };
    });
  }

  private async membershipsOf(tx: Tx, userId: string): Promise<MembershipSummary[]> {
    const rows = await tx
      .select({
        membershipId: memberships.id,
        tenantId: tenants.id,
        tenantSlug: tenants.slug,
        tenantName: tenants.displayName,
        tenantStatus: tenants.status,
        preset: tenants.preset,
        isDemo: tenants.isDemo,
      })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')))
      .orderBy(asc(tenants.displayName));
    if (rows.length === 0) return [];
    const roleRows = await tx
      .select({ membershipId: membershipRoles.membershipId, id: roles.id, key: roles.key, name: roles.name })
      .from(membershipRoles)
      .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
      .where(
        inArray(
          membershipRoles.membershipId,
          rows.map((r) => r.membershipId),
        ),
      );
    return rows.map((r) => ({
      ...r,
      roles: roleRows
        .filter((x) => x.membershipId === r.membershipId)
        .map(({ id, key, name }) => ({ id, key, name })),
    }));
  }

  async logout(auth: AuthState, meta: RequestMeta, all: boolean): Promise<void> {
    if (all) await this.sessions.revokeAllForUser(auth.userId);
    else await this.sessions.revoke(auth.sessionId);
    await this.db.system((tx) =>
      writeAudit(tx, {
        tenantId: null,
        actorType: auth.audience === 'platform' ? 'platform' : 'user',
        actorUserId: auth.userId,
        action: all ? 'auth.logout_all' : 'auth.logout',
        entityType: 'user',
        entityId: auth.userId,
        correlationId: meta.correlationId,
        ip: meta.ip,
      }),
    );
  }

  // ---------------------------------------------------------------- invitations

  private async findPendingInvitation(tx: Tx, token: string) {
    const [row] = await tx
      .select({ invitation: invitations, tenant: tenants })
      .from(invitations)
      .innerJoin(tenants, eq(tenants.id, invitations.tenantId))
      .where(eq(invitations.tokenHash, sha256(token)));
    if (!row || row.invitation.status !== 'pending' || row.invitation.expiresAt <= new Date()) {
      throw new AppError(404, 'INVITATION_INVALID', 'This invitation is invalid, expired or already used');
    }
    if (row.tenant.status !== 'active') {
      throw new AppError(404, 'INVITATION_INVALID', 'This merchant is not accepting new staff right now');
    }
    return row;
  }

  async previewInvitation(token: string): Promise<InvitationPreviewResponse> {
    return this.db.system(async (tx) => {
      const { invitation, tenant } = await this.findPendingInvitation(tx, token);
      const roleRows = await tx
        .select({ name: roles.name })
        .from(roles)
        .where(and(eq(roles.tenantId, tenant.id), inArray(roles.id, invitation.roleIds)));
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, invitation.email));
      return {
        email: invitation.email,
        tenantName: tenant.displayName,
        roles: roleRows.map((r) => r.name),
        expiresAt: invitation.expiresAt.toISOString(),
        userExists: Boolean(existing),
      };
    });
  }

  async acceptInvitation(
    input: AcceptInvitationRequest,
    meta: RequestMeta,
  ): Promise<{ tenantId: string; email: string; accountCreated: boolean }> {
    // Hash outside the transaction (argon2 is deliberately slow).
    const policy = Password.safeParse(input.password);
    const newHash = policy.success ? await hashPassword(input.password) : null;

    return this.db.system(async (tx) => {
      const { invitation, tenant } = await this.findPendingInvitation(tx, input.token);
      // Lock the invitation row so a token can only be redeemed once under concurrency.
      await tx
        .select({ id: invitations.id })
        .from(invitations)
        .where(eq(invitations.id, invitation.id))
        .for('update');
      const [fresh] = await tx.select().from(invitations).where(eq(invitations.id, invitation.id));
      if (!fresh || fresh.status !== 'pending') {
        throw new AppError(404, 'INVITATION_INVALID', 'This invitation is invalid, expired or already used');
      }

      let [user] = await tx.select().from(users).where(eq(users.email, invitation.email));
      let accountCreated = false;
      if (user) {
        if (!(await verifyPassword(user.passwordHash, input.password)) || user.status !== 'active') {
          throw new AppError(
            401,
            'INVALID_CREDENTIALS',
            'Enter the current password of this existing account',
          );
        }
      } else {
        if (!input.displayName)
          throw Errors.validation([{ path: 'displayName', message: 'Name is required' }]);
        if (!policy.success || !newHash) {
          throw Errors.validation(
            policy.error?.issues.map((i) => ({ path: 'password', message: i.message })) ?? [],
          );
        }
        [user] = await tx
          .insert(users)
          .values({ email: invitation.email, displayName: input.displayName, passwordHash: newHash })
          .returning();
        accountCreated = true;
      }
      if (!user) throw new Error('user resolution failed');

      const [existingMember] = await tx
        .select()
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenant.id), eq(memberships.userId, user.id)));
      if (existingMember) {
        throw new AppError(409, 'ALREADY_MEMBER', 'This account already belongs to this merchant');
      }

      const validRoles = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.tenantId, tenant.id), inArray(roles.id, invitation.roleIds)));
      if (validRoles.length === 0) {
        throw new AppError(409, 'INVITATION_INVALID', 'The roles on this invitation no longer exist');
      }
      const [member] = await tx
        .insert(memberships)
        .values({ tenantId: tenant.id, userId: user.id, locationScope: invitation.locationScope })
        .returning();
      await tx
        .insert(membershipRoles)
        .values(validRoles.map((r) => ({ tenantId: tenant.id, membershipId: member!.id, roleId: r.id })));
      await tx
        .update(invitations)
        .set({ status: 'accepted', acceptedBy: user.id, acceptedAt: new Date(), version: fresh.version + 1 })
        .where(eq(invitations.id, invitation.id));

      await writeAudit(tx, {
        tenantId: tenant.id,
        actorType: 'user',
        actorUserId: user.id,
        action: 'invitation.accepted',
        entityType: 'membership',
        entityId: member!.id,
        newValues: { email: user.email, roleIds: validRoles.map((r) => r.id), accountCreated },
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      await enqueueEvent(tx, {
        tenantId: tenant.id,
        eventType: 'MembershipChanged',
        aggregateType: 'membership',
        aggregateId: member!.id,
        correlationId: meta.correlationId,
        payload: { change: 'joined', userId: user.id },
      });
      return { tenantId: tenant.id, email: user.email, accountCreated };
    });
  }

  audienceOf(value: unknown): Audience {
    if (value === 'merchant' || value === 'platform') return value;
    throw Errors.validation([{ path: 'audience', message: 'audience must be merchant or platform' }]);
  }
}
