import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMember,
  CSRF,
  locationId,
  login,
  ownerPool,
  roleId,
  startApp,
  tenantId,
  type Agent,
} from '../helpers';

/** F-03: permission denial is enforced server-side; scoped members stay in scope; no privilege escalation. */
let app: INestApplication;
let aurum: string;
let northwind: string;
beforeAll(async () => {
  app = await startApp();
  aurum = await tenantId('aurum-wholesale');
  northwind = await tenantId('northwind-general');
});
afterAll(() => app.close());

const as = (agent: Agent, tenant: string) => ({
  get: (p: string) => agent.get(p).set('x-tenant-id', tenant),
  patch: (p: string) => agent.patch(p).set('x-tenant-id', tenant).set(CSRF),
  post: (p: string) => agent.post(p).set('x-tenant-id', tenant).set(CSRF),
});

describe('permission enforcement (F-03)', () => {
  it('viewer can read settings but not change them, regardless of UI', async () => {
    const viewer = as(await login(app, 'viewer@aurum.demo'), aurum);
    const settings = await viewer.get('/v1/admin/settings/general');
    expect(settings.status).toBe(200);
    const res = await viewer
      .patch('/v1/admin/settings/general')
      .send({ version: settings.body.version, displayName: 'Hacked' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'PERMISSION_DENIED', details: { permission: 'settings.manage' } });
    expect(
      (await ownerPool.query('select display_name from tenants where id = $1', [aurum])).rows[0].display_name,
    ).not.toBe('Hacked');
  });

  it('viewer cannot read the audit log, create stores or manage staff', async () => {
    const viewer = as(await login(app, 'viewer@aurum.demo'), aurum);
    expect((await viewer.get('/v1/admin/audit-events')).status).toBe(403);
    expect((await viewer.post('/v1/admin/stores').send({ code: 'x-store', name: 'X store' })).status).toBe(
      403,
    );
    expect(
      (
        await viewer
          .post('/v1/admin/invitations')
          .set('Idempotency-Key', 'viewer-invite-1')
          .send({ email: 'a@b.test', roleIds: [] })
      ).status,
    ).toBe(403);
  });

  it('context exposes exactly the effective permissions and gated navigation', async () => {
    const viewer = as(await login(app, 'viewer@aurum.demo'), aurum);
    const ctx = (await viewer.get('/v1/admin/context')).body;
    expect(ctx.permissions).not.toContain('settings.manage');
    expect(ctx.nav.map((n: { key: string }) => n.key)).not.toContain('audit');
    const owner = as(await login(app, 'owner@aurum.demo'), aurum);
    const ownerCtx = (await owner.get('/v1/admin/context')).body;
    expect(ownerCtx.nav.map((n: { key: string }) => n.key)).toEqual(
      expect.arrayContaining([
        'home',
        'audit',
        'settings-general',
        'settings-stores',
        'settings-locations',
        'settings-staff',
        'settings-roles',
      ]),
    );
  });

  it('the same user gets different permissions per tenant', async () => {
    const multi = await login(app, 'multi@demo.local');
    expect((await as(multi, aurum).get('/v1/admin/members')).status).toBe(403); // catalog editor in Aurum
    expect((await as(multi, northwind).get('/v1/admin/members')).status).toBe(200); // admin in Northwind
  });

  it('a suspended membership loses access on the next request', async () => {
    const { email, membershipId } = await createMember(aurum, ['viewer']);
    const agent = as(await login(app, email), aurum);
    expect((await agent.get('/v1/admin/context')).status).toBe(200);
    await ownerPool.query(`update memberships set status = 'suspended' where id = $1`, [membershipId]);
    const res = await agent.get('/v1/admin/context');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TENANT_ACCESS_DENIED');
  });
});

describe('location scope', () => {
  it('scoped inventory operator only sees assigned locations', async () => {
    const stock = as(await login(app, 'stock@aurum.demo'), aurum);
    const list = await stock.get('/v1/admin/locations');
    expect(list.status).toBe(200);
    expect(list.body.items.map((l: { code: string }) => l.code)).toEqual(['mumbai-branch']);
    expect(
      (await stock.get(`/v1/admin/locations/${await locationId('aurum-wholesale', 'jaipur-branch')}`)).status,
    ).toBe(404);
  });

  it('scoped managers can edit in-scope locations only and cannot create new ones', async () => {
    const mumbai = await locationId('aurum-wholesale', 'mumbai-branch');
    const jaipur = await locationId('aurum-wholesale', 'jaipur-branch');
    const { email } = await createMember(aurum, ['admin'], { locationScope: [mumbai] });
    const scoped = as(await login(app, email), aurum);
    const current = (await scoped.get(`/v1/admin/locations/${mumbai}`)).body;
    expect(
      (
        await scoped
          .patch(`/v1/admin/locations/${mumbai}`)
          .send({ version: current.version, name: 'Mumbai branch' })
      ).status,
    ).toBe(200);
    expect(
      (await scoped.patch(`/v1/admin/locations/${jaipur}`).send({ version: 0, name: 'Out of scope' })).status,
    ).toBe(404);
    const create = await scoped
      .post('/v1/admin/locations')
      .send({ code: 'pune-branch', name: 'Pune branch', type: 'branch' });
    expect(create.status).toBe(403);
    expect(create.body.code).toBe('LOCATION_OUT_OF_SCOPE');
  });
});

describe('privilege escalation guards', () => {
  it('a non-owner admin cannot grant the Owner role or change an owner', async () => {
    const { email } = await createMember(aurum, ['admin']);
    const admin = as(await login(app, email), aurum);
    const target = await createMember(aurum, ['viewer']);
    const res = await admin
      .patch(`/v1/admin/members/${target.membershipId}`)
      .send({ version: 0, roleIds: [await roleId(aurum, 'owner')] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PRIVILEGE_ESCALATION');
    const ownerMembership = (
      await ownerPool.query(
        `select m.id, m.version from memberships m join users u on u.id = m.user_id where u.email = 'owner@aurum.demo'`,
      )
    ).rows[0];
    const res2 = await admin
      .patch(`/v1/admin/members/${ownerMembership.id}`)
      .send({ version: ownerMembership.version, status: 'suspended' });
    expect(res2.body.code).toBe('PRIVILEGE_ESCALATION');
  });

  it('members cannot grant permissions they do not hold (via roles or invitations)', async () => {
    // Custom role with staff + roles management, but no settings.manage.
    const owner = as(await login(app, 'owner@aurum.demo'), aurum);
    const role = await owner.post('/v1/admin/roles').send({
      name: `Staff manager ${Date.now()}`,
      permissions: ['staff.read', 'staff.manage', 'roles.read', 'roles.manage'],
    });
    expect(role.status).toBe(201);
    const { email } = await createMember(aurum, []);
    await ownerPool.query(
      `insert into membership_roles (tenant_id, membership_id, role_id) select $1, m.id, $2 from memberships m join users u on u.id = m.user_id where u.email = $3`,
      [aurum, role.body.id, email],
    );
    const manager = as(await login(app, email), aurum);
    const escalate = await manager
      .post('/v1/admin/roles')
      .send({ name: 'Sneaky', permissions: ['settings.manage'] });
    expect(escalate.status).toBe(403);
    expect(escalate.body.code).toBe('PRIVILEGE_ESCALATION');
    const invite = await manager
      .post('/v1/admin/invitations')
      .set('Idempotency-Key', `esc-${Date.now()}`)
      .send({ email: 'sneaky@test.local', roleIds: [await roleId(aurum, 'admin')] });
    expect(invite.status).toBe(403);
    expect(invite.body.details.permissions).toContain('settings.manage');
  });

  it('nobody can change their own membership', async () => {
    const owner = as(await login(app, 'owner@aurum.demo'), aurum);
    const ctx = (await owner.get('/v1/admin/context')).body;
    const res = await owner
      .patch(`/v1/admin/members/${ctx.membership.id}`)
      .send({ version: 0, status: 'suspended' });
    expect(res.body.code).toBe('SELF_MODIFICATION');
  });

  it('ownership can never drop to zero through the API', async () => {
    const t = await tenantId('lumiere-fine');
    const coOwner = await createMember(t, ['owner']);
    const co = as(await login(app, coOwner.email), t);
    const original = (
      await ownerPool.query(
        `select m.id, m.version from memberships m join users u on u.id = m.user_id where u.email = 'owner@lumiere.demo'`,
      )
    ).rows[0];
    // An owner may demote another owner while at least one owner remains (themselves).
    const demote = await co
      .patch(`/v1/admin/members/${original.id}`)
      .send({ version: original.version, roleIds: [await roleId(t, 'admin')] });
    expect(demote.status).toBe(200);
    // The demoted user can no longer touch the remaining owner, and the remaining owner cannot change themselves,
    // so the LAST_OWNER guard is defence in depth that the API cannot even reach.
    const demoted = as(await login(app, 'owner@lumiere.demo'), t);
    expect(
      (
        await demoted
          .patch(`/v1/admin/members/${coOwner.membershipId}`)
          .send({ version: 0, status: 'suspended' })
      ).body.code,
    ).toBe('PRIVILEGE_ESCALATION');
    expect(
      (await co.patch(`/v1/admin/members/${coOwner.membershipId}`).send({ version: 0, status: 'suspended' }))
        .body.code,
    ).toBe('SELF_MODIFICATION');
    const owners = await ownerPool.query(
      `select count(*)::int as n from memberships m join membership_roles mr on mr.membership_id = m.id
         join roles r on r.id = mr.role_id where m.tenant_id = $1 and m.status = 'active' and r.key = 'owner'`,
      [t],
    );
    expect(owners.rows[0].n).toBe(1);
    // Restore the seeded owner for other suites.
    const restore = await co
      .patch(`/v1/admin/members/${original.id}`)
      .send({ version: demote.body.version, roleIds: [await roleId(t, 'owner')] });
    expect(restore.status).toBe(200);
  });
});

describe('platform permissions', () => {
  it('platform support can read tenants but not provision or suspend', async () => {
    const support = await login(app, 'support@uc.local', 'platform');
    expect((await support.get('/v1/platform/tenants')).status).toBe(200);
    const res = await support
      .post('/v1/platform/tenants')
      .set(CSRF)
      .set('Idempotency-Key', 'support-create-1')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    const suspend = await support
      .post(`/v1/platform/tenants/${aurum}/suspend`)
      .set(CSRF)
      .send({ version: 0, reason: 'testing support' });
    expect(suspend.status).toBe(403);
  });
});
