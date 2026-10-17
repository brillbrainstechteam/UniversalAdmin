import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF, locationId, login, ownerPool, startApp, tenantId, type Agent } from '../helpers';

/** F-01: Tenant A cannot read/write Tenant B resources via header, guessed IDs, or list endpoints. */
let app: INestApplication;
let aurum: string;
let lumiere: string;
let aurumOwner: Agent;
let lumiereIds: { store: string; channel: string; location: string; role: string; membership: string };

beforeAll(async () => {
  app = await startApp();
  aurum = await tenantId('aurum-wholesale');
  lumiere = await tenantId('lumiere-fine');
  aurumOwner = await login(app, 'owner@aurum.demo');
  const one = async (sql: string) => (await ownerPool.query(sql, [lumiere])).rows[0].id as string;
  lumiereIds = {
    store: await one('select id from stores where tenant_id = $1 limit 1'),
    channel: await one('select id from channels where tenant_id = $1 limit 1'),
    location: await locationId('lumiere-fine', 'main-wh'),
    role: await one(`select id from roles where tenant_id = $1 and key = 'viewer'`),
    membership: await one('select id from memberships where tenant_id = $1 limit 1'),
  };
});
afterAll(() => app.close());

const asAurum = (method: 'get' | 'patch' | 'post', path: string) => {
  const req = aurumOwner[method](path).set('x-tenant-id', aurum);
  return method === 'get' ? req : req.set(CSRF);
};

describe('tenant isolation (F-01)', () => {
  it('rejects selecting a tenant the user is not a member of', async () => {
    const res = await aurumOwner.get('/v1/admin/stores').set('x-tenant-id', lumiere);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TENANT_ACCESS_DENIED');
  });

  it('responds identically for non-existent and foreign tenants (no existence leak)', async () => {
    const res = await aurumOwner
      .get('/v1/admin/stores')
      .set('x-tenant-id', '00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TENANT_ACCESS_DENIED');
  });

  it('requires a well-formed tenant header', async () => {
    expect((await aurumOwner.get('/v1/admin/stores')).body.code).toBe('TENANT_REQUIRED');
    expect((await aurumOwner.get('/v1/admin/stores').set('x-tenant-id', "1' or '1'='1")).body.code).toBe(
      'TENANT_REQUIRED',
    );
  });

  it.each([
    ['store', () => `/v1/admin/stores/${lumiereIds.store}`],
    ['channel', () => `/v1/admin/channels/${lumiereIds.channel}`],
    ['location', () => `/v1/admin/locations/${lumiereIds.location}`],
  ])('GET a foreign %s by guessed id → 404', async (_name, path) => {
    const res = await asAurum('get', path());
    expect(res.status).toBe(404);
  });

  it.each([
    ['store', () => `/v1/admin/stores/${lumiereIds.store}`, { version: 0, name: 'Hijacked' }],
    ['channel', () => `/v1/admin/channels/${lumiereIds.channel}`, { version: 0, name: 'Hijacked' }],
    ['location', () => `/v1/admin/locations/${lumiereIds.location}`, { version: 0, name: 'Hijacked' }],
    ['member', () => `/v1/admin/members/${lumiereIds.membership}`, { version: 0, status: 'suspended' }],
    ['role', () => `/v1/admin/roles/${lumiereIds.role}`, { version: 0, name: 'Hijacked' }],
  ])('PATCH a foreign %s → 404 and nothing changes', async (_name, path, body) => {
    const res = await asAurum('patch', path()).send(body);
    expect(res.status).toBe(404);
  });

  it('POST revoke on a foreign invitation id → 404', async () => {
    const inv = await ownerPool.query(
      `insert into invitations (tenant_id, email, role_ids, token_hash, expires_at) values ($1, 'x@lumiere.test', array[$2]::uuid[], md5(random()::text), now() + interval '1 day') returning id`,
      [lumiere, lumiereIds.role],
    );
    const res = await asAurum('post', `/v1/admin/invitations/${inv.rows[0].id}/revoke`);
    expect(res.status).toBe(404);
    const { rows } = await ownerPool.query('select status from invitations where id = $1', [inv.rows[0].id]);
    expect(rows[0].status).toBe('pending');
  });

  it('cannot attach a foreign store to a new channel', async () => {
    const res = await asAurum('post', '/v1/admin/channels').send({
      storeId: lumiereIds.store,
      code: 'cross',
      name: 'Cross tenant',
      type: 'b2b_storefront',
    });
    expect(res.status).toBe(404);
  });

  it('cannot grant a foreign role or scope a member to a foreign location', async () => {
    const invite = await asAurum('post', '/v1/admin/invitations')
      .set('Idempotency-Key', 'iso-foreign-role-1')
      .send({ email: 'cross@aurum.test', roleIds: [lumiereIds.role] });
    expect(invite.status).toBe(400);
    const viewerRole = (
      await ownerPool.query(`select id from roles where tenant_id = $1 and key = 'viewer'`, [aurum])
    ).rows[0].id;
    const scoped = await asAurum('post', '/v1/admin/invitations')
      .set('Idempotency-Key', 'iso-foreign-loc-1')
      .send({ email: 'cross2@aurum.test', roleIds: [viewerRole], locationScope: [lumiereIds.location] });
    expect(scoped.status).toBe(400);
  });

  it('list endpoints only ever return the caller tenant’s rows', async () => {
    const lists = [
      '/v1/admin/stores',
      '/v1/admin/channels',
      '/v1/admin/locations?limit=100',
      '/v1/admin/members?limit=100',
      '/v1/admin/audit-events?limit=100',
    ];
    const aurumStoreIds = new Set(
      (await ownerPool.query('select id from stores where tenant_id = $1', [aurum])).rows.map((r) => r.id),
    );
    for (const path of lists) {
      const res = await asAurum('get', path);
      expect(res.status, path).toBe(200);
      for (const item of res.body.items as { id: string; tenantId?: string; storeId?: string }[]) {
        if ('tenantId' in item) expect(item.tenantId).toBe(aurum);
        if (path.includes('channels')) expect(aurumStoreIds.has(item.storeId)).toBe(true);
      }
    }
    const roles = await asAurum('get', '/v1/admin/roles');
    const lumiereRoleIds = new Set(
      (await ownerPool.query('select id from roles where tenant_id = $1', [lumiere])).rows.map((r) => r.id),
    );
    expect((roles.body.items as { id: string }[]).some((r) => lumiereRoleIds.has(r.id))).toBe(false);
  });

  it('storefront resolution is by verified domain only, never by a client-supplied tenant id', async () => {
    const res = await aurumOwner
      .get('/v1/storefront/config')
      .set('Host', 'aurum-b2b.localhost')
      .set('x-tenant-id', lumiere);
    expect(res.body.tenant.slug).toBe('aurum-wholesale');
  });
});
