import { Inject, Injectable } from '@nestjs/common';
import {
  isTenantPermission,
  TENANT_PERMISSIONS,
  type CreateInvitationRequest,
  type CreateInvitationResponse,
  type CreateRoleRequest,
  type Invitation,
  type Member,
  type MemberListQuery,
  type Page,
  type PermissionCatalog,
  type Role,
  type RoleRef,
  type UpdateMemberRequest,
  type UpdateRoleRequest,
  type z,
  type InvitationListQuery,
} from '@uc/contracts';
import {
  diff,
  enqueueEvent,
  generateToken,
  invitations,
  locations,
  membershipRoles,
  memberships,
  roles,
  sha256,
  users,
  writeAudit,
  type Tx,
} from '@uc/db';
import { and, asc, count, desc, eq, gt, ilike, inArray, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { decodeCursor, paginate } from '../../common/cursor';
import { AppError, Errors } from '../../common/errors';
import { iso, likePattern } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';

type RoleRow = typeof roles.$inferSelect;
type InvitationRow = typeof invitations.$inferSelect;

@Injectable()
export class StaffService {
  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------- shared guards

  private async rolesById(tx: Tx, ctx: TenantState, roleIds: readonly string[]): Promise<RoleRow[]> {
    const unique = [...new Set(roleIds)];
    const rows = unique.length
      ? await tx
          .select()
          .from(roles)
          .where(and(eq(roles.tenantId, ctx.tenantId), inArray(roles.id, unique)))
      : [];
    if (rows.length !== unique.length)
      throw Errors.validation([{ path: 'roleIds', message: 'Unknown role' }]);
    return rows;
  }

  /**
   * Separation of privilege: only owners grant/revoke ownership, and non-owners may only grant
   * permissions they themselves hold (prevents self-escalation via roles).
   */
  private assertCanGrant(ctx: TenantState, granted: RoleRow[]): void {
    if (ctx.isOwner) return;
    if (granted.some((r) => r.key === 'owner')) {
      throw new AppError(403, 'PRIVILEGE_ESCALATION', 'Only an owner can grant the Owner role');
    }
    const missing = granted
      .flatMap((r) => r.permissions)
      .filter((p) => isTenantPermission(p) && !ctx.permissions.has(p));
    if (missing.length) {
      throw new AppError(403, 'PRIVILEGE_ESCALATION', 'You cannot grant permissions you do not hold', {
        permissions: [...new Set(missing)],
      });
    }
  }

  private async assertLocationsInTenant(tx: Tx, ctx: TenantState, ids: readonly string[] | null | undefined) {
    if (!ids || ids.length === 0) return;
    const unique = [...new Set(ids)];
    const found = await tx
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.tenantId, ctx.tenantId), inArray(locations.id, unique)));
    if (found.length !== unique.length)
      throw Errors.validation([{ path: 'locationScope', message: 'Unknown location' }]);
  }

  private async rolesOfMemberships(tx: Tx, ctx: TenantState, membershipIds: string[]) {
    if (membershipIds.length === 0) return new Map<string, RoleRef[]>();
    const rows = await tx
      .select({ membershipId: membershipRoles.membershipId, id: roles.id, key: roles.key, name: roles.name })
      .from(membershipRoles)
      .innerJoin(
        roles,
        and(eq(roles.id, membershipRoles.roleId), eq(roles.tenantId, membershipRoles.tenantId)),
      )
      .where(
        and(eq(membershipRoles.tenantId, ctx.tenantId), inArray(membershipRoles.membershipId, membershipIds)),
      )
      .orderBy(asc(roles.name));
    const map = new Map<string, RoleRef[]>();
    for (const r of rows)
      map.set(r.membershipId, [...(map.get(r.membershipId) ?? []), { id: r.id, key: r.key, name: r.name }]);
    return map;
  }

  // ---------------------------------------------------------------- members

  async listMembers(ctx: TenantState, query: MemberListQuery): Promise<Page<Member>> {
    const cursor = decodeCursor(query.cursor);
    const where: (SQL | undefined)[] = [eq(memberships.tenantId, ctx.tenantId)];
    if (query.q)
      where.push(
        or(ilike(users.email, likePattern(query.q)), ilike(users.displayName, likePattern(query.q))),
      );
    if (query.status) where.push(eq(memberships.status, query.status));
    if (query.roleId) {
      where.push(
        sql`exists (select 1 from ${membershipRoles} mr where mr.membership_id = "memberships"."id" and mr.role_id = ${query.roleId})`,
      );
    }
    if (cursor) {
      const email = String(cursor.sortValue);
      where.push(or(gt(users.email, email), and(eq(users.email, email), gt(memberships.id, cursor.id))));
    }
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const rows = await tx
        .select({ m: memberships, u: users })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(...where))
        .orderBy(asc(users.email), asc(memberships.id))
        .limit(query.limit + 1);
      const page = paginate(
        rows.map((r) => ({ id: r.m.id, ...r })),
        query.limit,
        (r) => r.u.email,
      );
      const roleMap = await this.rolesOfMemberships(
        tx,
        ctx,
        page.items.map((r) => r.m.id),
      );
      return {
        items: page.items.map((r) => this.toMember(r.m, r.u, roleMap.get(r.m.id) ?? [])),
        nextCursor: page.nextCursor,
      };
    });
  }

  private toMember(
    m: typeof memberships.$inferSelect,
    u: typeof users.$inferSelect,
    roleRefs: RoleRef[],
  ): Member {
    return {
      id: m.id,
      user: { id: u.id, email: u.email, displayName: u.displayName },
      status: m.status,
      roles: roleRefs,
      locationScope: m.locationScope ?? null,
      version: m.version,
      createdAt: iso(m.createdAt),
      updatedAt: iso(m.updatedAt),
    };
  }

  async updateMember(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: UpdateMemberRequest,
    meta: RequestMeta,
  ): Promise<Member> {
    if (id === ctx.membershipId) {
      throw new AppError(403, 'SELF_MODIFICATION', 'You cannot change your own roles, status or scope');
    }
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .select({ m: memberships, u: users })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.tenantId, ctx.tenantId), eq(memberships.id, id)))
        .for('update', { of: memberships });
      if (!row) throw Errors.notFound('Member');
      if (row.m.version !== input.version) throw Errors.versionConflict(row.m.version);

      const currentRoles = (await this.rolesOfMemberships(tx, ctx, [id])).get(id) ?? [];
      const targetIsOwner = currentRoles.some((r) => r.key === 'owner');
      if (targetIsOwner && !ctx.isOwner) {
        throw new AppError(403, 'PRIVILEGE_ESCALATION', 'Only an owner can change another owner');
      }

      let nextRoles = currentRoles;
      if (input.roleIds) {
        const granted = await this.rolesById(tx, ctx, input.roleIds);
        const added = granted.filter((r) => !currentRoles.some((c) => c.id === r.id));
        this.assertCanGrant(ctx, added);
        nextRoles = granted.map((r) => ({ id: r.id, key: r.key, name: r.name }));
      }
      const nextStatus = input.status ?? row.m.status;
      const remainsActiveOwner = nextStatus === 'active' && nextRoles.some((r) => r.key === 'owner');
      if (targetIsOwner && row.m.status === 'active' && !remainsActiveOwner) {
        const [others] = await tx
          .select({ n: count() })
          .from(memberships)
          .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
          .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
          .where(
            and(
              eq(memberships.tenantId, ctx.tenantId),
              eq(memberships.status, 'active'),
              eq(roles.key, 'owner'),
              ne(memberships.id, id),
            ),
          );
        if ((others?.n ?? 0) === 0) {
          throw new AppError(409, 'LAST_OWNER', 'A merchant must keep at least one active owner');
        }
      }
      if (input.locationScope !== undefined) await this.assertLocationsInTenant(tx, ctx, input.locationScope);

      const [updated] = await tx
        .update(memberships)
        .set({
          status: nextStatus,
          locationScope: input.locationScope === undefined ? row.m.locationScope : input.locationScope,
          version: row.m.version + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(memberships.tenantId, ctx.tenantId),
            eq(memberships.id, id),
            eq(memberships.version, input.version),
          ),
        )
        .returning();
      if (!updated) throw Errors.versionConflict();
      if (input.roleIds) {
        await tx
          .delete(membershipRoles)
          .where(and(eq(membershipRoles.tenantId, ctx.tenantId), eq(membershipRoles.membershipId, id)));
        await tx
          .insert(membershipRoles)
          .values(nextRoles.map((r) => ({ tenantId: ctx.tenantId, membershipId: id, roleId: r.id })));
      }

      const before = {
        status: row.m.status,
        roles: currentRoles.map((r) => r.key).sort(),
        locationScope: row.m.locationScope,
      };
      const after = {
        status: updated.status,
        roles: nextRoles.map((r) => r.key).sort(),
        locationScope: updated.locationScope,
      };
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: auth.userId,
        action:
          before.status !== after.status
            ? `member.${after.status === 'suspended' ? 'suspended' : 'reactivated'}`
            : 'member.updated',
        entityType: 'membership',
        entityId: id,
        ...diff(before, after),
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      await enqueueEvent(tx, {
        tenantId: ctx.tenantId,
        eventType: 'MembershipChanged',
        aggregateType: 'membership',
        aggregateId: id,
        aggregateVersion: updated.version,
        correlationId: meta.correlationId,
        payload: { change: 'updated', userId: row.u.id, status: updated.status, roles: after.roles },
      });
      return this.toMember(updated, row.u, nextRoles);
    });
  }

  // ---------------------------------------------------------------- invitations

  private effectiveStatus(row: InvitationRow): Invitation['status'] {
    return row.status === 'pending' && row.expiresAt <= new Date() ? 'expired' : row.status;
  }

  private async toInvitations(tx: Tx, ctx: TenantState, rows: InvitationRow[]): Promise<Invitation[]> {
    const roleIds = [...new Set(rows.flatMap((r) => r.roleIds))];
    const inviterIds = [...new Set(rows.map((r) => r.invitedBy).filter((x): x is string => Boolean(x)))];
    const roleRows = roleIds.length
      ? await tx
          .select()
          .from(roles)
          .where(and(eq(roles.tenantId, ctx.tenantId), inArray(roles.id, roleIds)))
      : [];
    const inviters = inviterIds.length
      ? await tx.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, inviterIds))
      : [];
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      status: this.effectiveStatus(r),
      roles: roleRows
        .filter((x) => r.roleIds.includes(x.id))
        .map((x) => ({ id: x.id, key: x.key, name: x.name })),
      locationScope: r.locationScope ?? null,
      expiresAt: iso(r.expiresAt),
      createdAt: iso(r.createdAt),
      invitedBy: inviters.find((i) => i.id === r.invitedBy) ?? null,
    }));
  }

  async listInvitations(
    ctx: TenantState,
    query: z.infer<typeof InvitationListQuery>,
  ): Promise<Page<Invitation>> {
    const cursor = decodeCursor(query.cursor);
    const now = new Date();
    const where: (SQL | undefined)[] = [eq(invitations.tenantId, ctx.tenantId)];
    if (query.status === 'pending')
      where.push(and(eq(invitations.status, 'pending'), gt(invitations.expiresAt, now)));
    else if (query.status === 'expired')
      where.push(
        or(
          eq(invitations.status, 'expired'),
          and(eq(invitations.status, 'pending'), lte(invitations.expiresAt, now)),
        ),
      );
    else if (query.status) where.push(eq(invitations.status, query.status));
    if (cursor) {
      const at = new Date(String(cursor.sortValue));
      where.push(
        or(lt(invitations.createdAt, at), and(eq(invitations.createdAt, at), lt(invitations.id, cursor.id))),
      );
    }
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(invitations)
        .where(and(...where))
        .orderBy(desc(invitations.createdAt), desc(invitations.id))
        .limit(query.limit + 1);
      const page = paginate(rows, query.limit, (r) => r.createdAt.toISOString());
      return { items: await this.toInvitations(tx, ctx, page.items), nextCursor: page.nextCursor };
    });
  }

  async createInvitation(
    auth: AuthState,
    ctx: TenantState,
    input: CreateInvitationRequest,
    meta: RequestMeta,
  ): Promise<CreateInvitationResponse> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const granted = await this.rolesById(tx, ctx, input.roleIds);
      this.assertCanGrant(ctx, granted);
      await this.assertLocationsInTenant(tx, ctx, input.locationScope);

      const [member] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.tenantId, ctx.tenantId), eq(users.email, input.email)));
      if (member) throw new AppError(409, 'ALREADY_MEMBER', 'This person is already a staff member');

      // Expire stale pending invitations so the pending-email uniqueness only covers live ones.
      await tx
        .update(invitations)
        .set({ status: 'expired' })
        .where(
          and(
            eq(invitations.tenantId, ctx.tenantId),
            eq(invitations.email, input.email),
            eq(invitations.status, 'pending'),
            lte(invitations.expiresAt, new Date()),
          ),
        );
      const [pending] = await tx
        .select({ id: invitations.id })
        .from(invitations)
        .where(
          and(
            eq(invitations.tenantId, ctx.tenantId),
            eq(invitations.email, input.email),
            eq(invitations.status, 'pending'),
          ),
        );
      if (pending)
        throw new AppError(409, 'INVITATION_PENDING', 'An invitation for this email is already pending');

      const token = generateToken();
      const [row] = await tx
        .insert(invitations)
        .values({
          tenantId: ctx.tenantId,
          email: input.email,
          roleIds: granted.map((r) => r.id),
          locationScope: input.locationScope ?? null,
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + this.config.invitationTtlMs),
          invitedBy: auth.userId,
        })
        .returning();
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: 'invitation.created',
        entityType: 'invitation',
        entityId: row!.id,
        newValues: {
          email: input.email,
          roles: granted.map((r) => r.key),
          locationScope: input.locationScope ?? null,
        },
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      const [invitation] = await this.toInvitations(tx, ctx, [row!]);
      // Token travels in the URL fragment so it never reaches server logs (ADR-010).
      return {
        invitation: invitation!,
        inviteUrl: `${this.config.MERCHANT_ADMIN_URL}/accept-invite#token=${token}`,
      };
    });
  }

  async revokeInvitation(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    meta: RequestMeta,
  ): Promise<Invitation> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(invitations)
        .where(and(eq(invitations.tenantId, ctx.tenantId), eq(invitations.id, id)))
        .for('update');
      if (!row) throw Errors.notFound('Invitation');
      if (this.effectiveStatus(row) !== 'pending') {
        throw new AppError(
          409,
          'INVALID_STATE_TRANSITION',
          `Cannot revoke an invitation that is ${this.effectiveStatus(row)}`,
        );
      }
      const [updated] = await tx
        .update(invitations)
        .set({ status: 'revoked', revokedAt: new Date(), version: row.version + 1 })
        .where(eq(invitations.id, id))
        .returning();
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: 'invitation.revoked',
        entityType: 'invitation',
        entityId: id,
        oldValues: { status: 'pending' },
        newValues: { status: 'revoked', email: row.email },
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return (await this.toInvitations(tx, ctx, [updated!]))[0]!;
    });
  }

  // ---------------------------------------------------------------- roles

  private toRole(r: RoleRow, memberCount: number): Role {
    return {
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
      permissions: [...r.permissions].sort(),
      memberCount,
      version: r.version,
      createdAt: iso(r.createdAt),
      updatedAt: iso(r.updatedAt),
    };
  }

  private async roleCounts(tx: Tx, ctx: TenantState): Promise<Map<string, number>> {
    const rows = await tx
      .select({ roleId: membershipRoles.roleId, n: count() })
      .from(membershipRoles)
      .innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
      .where(and(eq(membershipRoles.tenantId, ctx.tenantId), eq(memberships.status, 'active')))
      .groupBy(membershipRoles.roleId);
    return new Map(rows.map((r) => [r.roleId, r.n]));
  }

  async listRoles(ctx: TenantState): Promise<{ items: Role[] }> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(roles)
        .where(eq(roles.tenantId, ctx.tenantId))
        .orderBy(desc(roles.isSystem), asc(roles.name));
      const counts = await this.roleCounts(tx, ctx);
      return { items: rows.map((r) => this.toRole(r, counts.get(r.id) ?? 0)) };
    });
  }

  permissionCatalog(): PermissionCatalog {
    return {
      items: Object.entries(TENANT_PERMISSIONS).map(([key, def]) => ({
        key,
        group: def.group,
        label: def.label,
        phase: def.phase,
      })),
    };
  }

  private validatePermissions(ctx: TenantState, permissions: string[]): string[] {
    const unknown = permissions.filter((p) => !isTenantPermission(p));
    if (unknown.length)
      throw Errors.validation([
        { path: 'permissions', message: `Unknown permissions: ${unknown.join(', ')}` },
      ]);
    const unique = [...new Set(permissions)].sort();
    if (!ctx.isOwner) {
      const missing = unique.filter((p) => isTenantPermission(p) && !ctx.permissions.has(p));
      if (missing.length) {
        throw new AppError(403, 'PRIVILEGE_ESCALATION', 'You cannot grant permissions you do not hold', {
          permissions: missing,
        });
      }
    }
    return unique;
  }

  async createRole(
    auth: AuthState,
    ctx: TenantState,
    input: CreateRoleRequest,
    meta: RequestMeta,
  ): Promise<Role> {
    const permissions = this.validatePermissions(ctx, input.permissions);
    const slug = input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    if (!slug) throw Errors.validation([{ path: 'name', message: 'Name must contain letters or digits' }]);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .insert(roles)
        .values({
          tenantId: ctx.tenantId,
          key: `custom-${slug}`,
          name: input.name,
          description: input.description,
          permissions,
        })
        .returning();
      const role = this.toRole(row!, 0);
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: 'role.created',
        entityType: 'role',
        entityId: role.id,
        newValues: { name: role.name, permissions },
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return role;
    });
  }

  async updateRole(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: UpdateRoleRequest,
    meta: RequestMeta,
  ): Promise<Role> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [before] = await tx
        .select()
        .from(roles)
        .where(and(eq(roles.tenantId, ctx.tenantId), eq(roles.id, id)))
        .for('update');
      if (!before) throw Errors.notFound('Role');
      if (before.isSystem)
        throw new AppError(
          403,
          'SYSTEM_ROLE_READONLY',
          'System roles cannot be edited; create a custom role',
        );
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      const permissions = input.permissions
        ? this.validatePermissions(ctx, input.permissions)
        : before.permissions;
      const [after] = await tx
        .update(roles)
        .set({
          name: input.name ?? before.name,
          description: input.description ?? before.description,
          permissions,
          version: before.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(roles.tenantId, ctx.tenantId), eq(roles.id, id), eq(roles.version, input.version)))
        .returning();
      if (!after) throw Errors.versionConflict();
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: 'role.updated',
        entityType: 'role',
        entityId: id,
        ...diff(
          { name: before.name, description: before.description, permissions: [...before.permissions].sort() },
          { name: after.name, description: after.description, permissions: [...after.permissions].sort() },
        ),
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      const counts = await this.roleCounts(tx, ctx);
      return this.toRole(after, counts.get(id) ?? 0);
    });
  }
}
