import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditCount,
  CSRF,
  locationId,
  login,
  ownerPool,
  roleId,
  startApp,
  tenantId,
  TEST_PASSWORD,
  uniqueEmail,
  type Agent,
} from '../helpers';

let app: INestApplication;
let aurum: string;
let agent: Agent;
const post = (p: string) => agent.post(p).set('x-tenant-id', aurum).set(CSRF);
const get = (p: string) => agent.get(p).set('x-tenant-id', aurum);
const tokenOf = (inviteUrl: string) => inviteUrl.split('#token=')[1]!;
const anon = () => request(app.getHttpServer());

beforeAll(async () => {
  app = await startApp();
  aurum = await tenantId('aurum-wholesale');
  agent = await login(app, 'owner@aurum.demo');
});
afterAll(() => app.close());

describe('invitations', () => {
  it('requires an Idempotency-Key', async () => {
    const res = await post('/v1/admin/invitations').send({
      email: uniqueEmail('inv'),
      roleIds: [await roleId(aurum, 'viewer')],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('replays the same response for the same key and rejects key reuse with a different body (ADR-007)', async () => {
    const body = { email: uniqueEmail('idem'), roleIds: [await roleId(aurum, 'viewer')] };
    const key = `idem-${Date.now()}`;
    const first = await post('/v1/admin/invitations').set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(201);
    const second = await post('/v1/admin/invitations').set('Idempotency-Key', key).send(body);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.invitation.id).toBe(first.body.invitation.id);
    const count = await ownerPool.query('select count(*)::int as n from invitations where email = $1', [
      body.email,
    ]);
    expect(count.rows[0].n).toBe(1);
    const reused = await post('/v1/admin/invitations')
      .set('Idempotency-Key', key)
      .send({ ...body, email: uniqueEmail('other') });
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('stores only a token hash, puts the token in the URL fragment, and never audits the token', async () => {
    const email = uniqueEmail('hash');
    const res = await post('/v1/admin/invitations')
      .set('Idempotency-Key', `hash-${Date.now()}`)
      .send({ email, roleIds: [await roleId(aurum, 'viewer')] });
    expect(res.body.inviteUrl).toMatch(/^http:\/\/localhost:3100\/accept-invite#token=[A-Za-z0-9_-]{40,}$/);
    const token = tokenOf(res.body.inviteUrl);
    const { rows } = await ownerPool.query('select token_hash from invitations where email = $1', [email]);
    expect(rows[0].token_hash).not.toContain(token);
    const audit = await ownerPool.query(
      `select new_values::text as v from audit_events where action = 'invitation.created' and entity_id = $1`,
      [res.body.invitation.id],
    );
    expect(audit.rows[0].v).not.toContain(token);
  });

  it('rejects inviting an existing member or a duplicate pending invitation', async () => {
    const member = await post('/v1/admin/invitations')
      .set('Idempotency-Key', `mem-${Date.now()}`)
      .send({ email: 'viewer@aurum.demo', roleIds: [await roleId(aurum, 'viewer')] });
    expect(member.body.code).toBe('ALREADY_MEMBER');
    const email = uniqueEmail('dup');
    await post('/v1/admin/invitations')
      .set('Idempotency-Key', `dup1-${Date.now()}`)
      .send({ email, roleIds: [await roleId(aurum, 'viewer')] });
    const dup = await post('/v1/admin/invitations')
      .set('Idempotency-Key', `dup2-${Date.now()}`)
      .send({ email, roleIds: [await roleId(aurum, 'viewer')] });
    expect(dup.body.code).toBe('INVITATION_PENDING');
  });

  it('new user accepts: account + membership with roles and location scope; token is single-use', async () => {
    const email = uniqueEmail('new');
    const mumbai = await locationId('aurum-wholesale', 'mumbai-branch');
    const inv = await post('/v1/admin/invitations')
      .set('Idempotency-Key', `new-${Date.now()}`)
      .send({ email, roleIds: [await roleId(aurum, 'inventory_operator')], locationScope: [mumbai] });
    const token = tokenOf(inv.body.inviteUrl);
    const preview = await anon().post('/v1/auth/invitations/preview').set(CSRF).send({ token });
    expect(preview.body).toMatchObject({ email, userExists: false, roles: ['Inventory operator'] });
    const weak = await anon()
      .post('/v1/auth/invitations/accept')
      .set(CSRF)
      .send({ token, displayName: 'New Person', password: 'short' });
    expect(weak.status).toBe(400);
    const ok = await anon()
      .post('/v1/auth/invitations/accept')
      .set(CSRF)
      .send({ token, displayName: 'New Person', password: 'a-long-enough-pass' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ tenantId: aurum, accountCreated: true });
    const again = await anon()
      .post('/v1/auth/invitations/accept')
      .set(CSRF)
      .send({ token, displayName: 'New Person', password: 'a-long-enough-pass' });
    expect(again.body.code).toBe('INVITATION_INVALID');
    const newcomer = await login(app, email, 'merchant', 'a-long-enough-pass');
    const ctx = (await newcomer.get('/v1/admin/context').set('x-tenant-id', aurum)).body;
    expect(ctx.membership.locationScope).toEqual([mumbai]);
    expect(ctx.permissions).toContain('inventory.adjust');
    expect(await auditCount(aurum, 'invitation.accepted')).toBeGreaterThan(0);
    const outbox = await ownerPool.query(
      `select count(*)::int as n from outbox_events where tenant_id = $1 and event_type = 'MembershipChanged'`,
      [aurum],
    );
    expect(outbox.rows[0].n).toBeGreaterThan(0);
  });

  it('an existing account must confirm its password to join another merchant', async () => {
    const lumiere = await tenantId('lumiere-fine');
    const lumiereOwner = await login(app, 'owner@lumiere.demo');
    const inv = await lumiereOwner
      .post('/v1/admin/invitations')
      .set('x-tenant-id', lumiere)
      .set(CSRF)
      .set('Idempotency-Key', `exist-${Date.now()}`)
      .send({ email: 'viewer@aurum.demo', roleIds: [await roleId(lumiere, 'viewer')] });
    const token = tokenOf(inv.body.inviteUrl);
    expect(
      (await anon().post('/v1/auth/invitations/preview').set(CSRF).send({ token })).body.userExists,
    ).toBe(true);
    const wrong = await anon()
      .post('/v1/auth/invitations/accept')
      .set(CSRF)
      .send({ token, password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    const ok = await anon()
      .post('/v1/auth/invitations/accept')
      .set(CSRF)
      .send({ token, password: TEST_PASSWORD });
    expect(ok.body.accountCreated).toBe(false);
  });

  it('revoked and expired invitations cannot be used', async () => {
    const inv = await post('/v1/admin/invitations')
      .set('Idempotency-Key', `rev-${Date.now()}`)
      .send({ email: uniqueEmail('rev'), roleIds: [await roleId(aurum, 'viewer')] });
    const revoked = await post(`/v1/admin/invitations/${inv.body.invitation.id}/revoke`);
    expect(revoked.body.status).toBe('revoked');
    expect((await post(`/v1/admin/invitations/${inv.body.invitation.id}/revoke`)).body.code).toBe(
      'INVALID_STATE_TRANSITION',
    );
    expect(
      (
        await anon()
          .post('/v1/auth/invitations/preview')
          .set(CSRF)
          .send({ token: tokenOf(inv.body.inviteUrl) })
      ).status,
    ).toBe(404);

    const exp = await post('/v1/admin/invitations')
      .set('Idempotency-Key', `exp-${Date.now()}`)
      .send({ email: uniqueEmail('exp'), roleIds: [await roleId(aurum, 'viewer')] });
    await ownerPool.query(`update invitations set expires_at = now() - interval '1 minute' where id = $1`, [
      exp.body.invitation.id,
    ]);
    expect(
      (
        await anon()
          .post('/v1/auth/invitations/preview')
          .set(CSRF)
          .send({ token: tokenOf(exp.body.inviteUrl) })
      ).status,
    ).toBe(404);
    const listed = await get('/v1/admin/invitations?status=expired');
    expect(listed.body.items.map((i: { id: string }) => i.id)).toContain(exp.body.invitation.id);
  });
});

describe('members and roles', () => {
  it('lists members with search and role filter', async () => {
    const res = await get(`/v1/admin/members?roleId=${await roleId(aurum, 'viewer')}`);
    expect(res.status).toBe(200);
    expect(
      res.body.items.every((m: { roles: { key: string }[] }) => m.roles.some((r) => r.key === 'viewer')),
    ).toBe(true);
    const search = await get('/v1/admin/members?q=stock@');
    expect(search.body.items.map((m: { user: { email: string } }) => m.user.email)).toEqual([
      'stock@aurum.demo',
    ]);
  });

  it('changing roles is versioned, audited and emits MembershipChanged', async () => {
    const member = (await get('/v1/admin/members?q=stock@')).body.items[0];
    const res = await agent
      .patch(`/v1/admin/members/${member.id}`)
      .set('x-tenant-id', aurum)
      .set(CSRF)
      .send({
        version: member.version,
        roleIds: [await roleId(aurum, 'inventory_operator'), await roleId(aurum, 'fulfillment_operator')],
      });
    expect(res.status).toBe(200);
    expect(res.body.roles.map((r: { key: string }) => r.key).sort()).toEqual([
      'fulfillment_operator',
      'inventory_operator',
    ]);
    const stale = await agent
      .patch(`/v1/admin/members/${member.id}`)
      .set('x-tenant-id', aurum)
      .set(CSRF)
      .send({ version: member.version, status: 'suspended' });
    expect(stale.body.code).toBe('VERSION_CONFLICT');
  });

  it('system roles are read-only; custom roles validate permission keys', async () => {
    const roles = (await get('/v1/admin/roles')).body.items;
    const viewer = roles.find((r: { key: string }) => r.key === 'viewer');
    expect(viewer.isSystem).toBe(true);
    const edit = await agent
      .patch(`/v1/admin/roles/${viewer.id}`)
      .set('x-tenant-id', aurum)
      .set(CSRF)
      .send({ version: viewer.version, name: 'Mine' });
    expect(edit.body.code).toBe('SYSTEM_ROLE_READONLY');
    const bad = await post('/v1/admin/roles').send({ name: 'Bad role', permissions: ['everything.all'] });
    expect(bad.status).toBe(400);
    const good = await post('/v1/admin/roles').send({
      name: 'Showroom lead',
      description: 'Front of house',
      permissions: ['locations.read', 'stores.read'],
    });
    expect(good.status).toBe(201);
    expect(good.body).toMatchObject({
      key: 'custom-showroom-lead',
      isSystem: false,
      permissions: ['locations.read', 'stores.read'],
    });
    const dup = await post('/v1/admin/roles').send({ name: 'Showroom lead', permissions: [] });
    expect(dup.body.code).toBe('DUPLICATE');
    const catalog = await get('/v1/admin/permissions');
    expect(catalog.body.items.find((p: { key: string }) => p.key === 'rates.approve').phase).toBe(6);
  });
});
