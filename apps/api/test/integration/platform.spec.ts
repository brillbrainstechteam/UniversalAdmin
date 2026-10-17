import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditCount, CSRF, login, ownerPool, startApp, tenantId, type Agent } from '../helpers';

let app: INestApplication;
let platform: Agent;
beforeAll(async () => {
  app = await startApp();
  platform = await login(app, 'platform@uc.local', 'platform');
});
afterAll(() => app.close());

const newTenant = (slug: string, preset = 'b2c_jewellery') => ({
  slug,
  displayName: `Test ${slug}`,
  legalName: `Test ${slug} Pvt Ltd`,
  preset,
  countryCode: 'IN',
  defaultCurrency: 'INR',
  timezone: 'Asia/Kolkata',
  defaultLocale: 'en-IN',
  contactEmail: `hello@${slug}.test`,
  ownerEmail: `owner@${slug}.test`,
});
const create = (body: object, key: string) =>
  platform.post('/v1/platform/tenants').set(CSRF).set('Idempotency-Key', key).send(body);

describe('tenant provisioning (F-07)', () => {
  it('provisions store, preset channels, main location, system roles, owner invitation, audit and outbox atomically', async () => {
    const res = await create(newTenant('hybrid-one', 'hybrid_jewellery'), 'prov-hybrid-one');
    expect(res.status).toBe(201);
    const t = res.body.tenant;
    expect(t).toMatchObject({
      slug: 'hybrid-one',
      status: 'active',
      preset: 'hybrid_jewellery',
      isDemo: false,
    });
    expect(t.counts).toMatchObject({
      stores: 1,
      channels: 2,
      locations: 1,
      activeMembers: 0,
      pendingInvitations: 1,
    });
    expect(res.body.ownerInvitation.inviteUrl).toMatch(/#token=/);
    const roles = await ownerPool.query(
      'select count(*)::int as n from roles where tenant_id = $1 and is_system',
      [t.id],
    );
    expect(roles.rows[0].n).toBe(11);
    expect(await auditCount(t.id, 'tenant.provisioned')).toBe(1);
    const outbox = await ownerPool.query(
      `select event_type, payload from outbox_events where tenant_id = $1`,
      [t.id],
    );
    expect(outbox.rows).toEqual([
      {
        event_type: 'TenantProvisioned',
        payload: { slug: 'hybrid-one', preset: 'hybrid_jewellery', isDemo: false },
      },
    ]);
  });

  it('is idempotent per key and rejects duplicate slugs', async () => {
    const body = newTenant('idem-shop');
    const a = await create(body, 'prov-idem-shop');
    const b = await create(body, 'prov-idem-shop');
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.tenant.id).toBe(a.body.tenant.id);
    const dup = await create(body, 'prov-idem-shop-2');
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'DUPLICATE', details: { field: 'slug' } });
    // A failed request does not burn its key or leave partial data.
    expect(
      (await ownerPool.query(`select count(*)::int as n from tenants where slug = 'idem-shop'`)).rows[0].n,
    ).toBe(1);
  });

  it('owner accepts the invitation and lands in a working tenant', async () => {
    const res = await create(newTenant('owner-flow'), 'prov-owner-flow');
    const token = res.body.ownerInvitation.inviteUrl.split('#token=')[1];
    const accept = await request(app.getHttpServer())
      .post('/v1/auth/invitations/accept')
      .set(CSRF)
      .send({ token, displayName: 'Owner Flow', password: 'owner-flow-password' });
    expect(accept.status).toBe(200);
    const owner = await login(app, 'owner@owner-flow.test', 'merchant', 'owner-flow-password');
    const ctx = await owner.get('/v1/admin/context').set('x-tenant-id', res.body.tenant.id);
    expect(ctx.body.membership.roles[0].key).toBe('owner');
    expect(ctx.body.features).toContain('b2c_storefront');
    // Member counts reflect the accepted owner in both detail and list views (regression: unqualified subquery).
    const detail = await platform.get(`/v1/platform/tenants/${res.body.tenant.id}`);
    expect(detail.body.counts).toMatchObject({ activeMembers: 1, pendingInvitations: 0 });
    const listed = await platform.get('/v1/platform/tenants?q=owner-flow');
    expect(listed.body.items[0].memberCount).toBe(1);
    const aurum = await platform.get('/v1/platform/tenants?q=aurum');
    const seeded = (
      await ownerPool.query(
        `select count(*)::int as n from memberships m join tenants t on t.id = m.tenant_id where t.slug = 'aurum-wholesale' and m.status = 'active'`,
      )
    ).rows[0].n;
    expect(aurum.body.items[0].memberCount).toBe(seeded);
  });

  it('lists with search, filters, sort and pagination', async () => {
    const page1 = await platform.get('/v1/platform/tenants?limit=2&sort=displayName');
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await platform.get(
      `/v1/platform/tenants?limit=2&sort=displayName&cursor=${page1.body.nextCursor}`,
    );
    const names = [...page1.body.items, ...page2.body.items].map(
      (t: { displayName: string }) => t.displayName,
    );
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    const search = await platform.get('/v1/platform/tenants?q=lumi');
    expect(search.body.items.map((t: { slug: string }) => t.slug)).toEqual(['lumiere-fine']);
    const general = await platform.get('/v1/platform/tenants?preset=general_commerce');
    expect(general.body.items.every((t: { preset: string }) => t.preset === 'general_commerce')).toBe(true);
  });
});

describe('suspension lifecycle', () => {
  it('suspension blocks merchant staff and storefront; reactivation restores; transitions are guarded', async () => {
    const res = await create(newTenant('suspend-me'), 'prov-suspend-me');
    const t = res.body.tenant;
    await ownerPool.query(
      `insert into channel_domains (tenant_id, channel_id, hostname, status, is_primary) select tenant_id, id, 'suspend-me.localhost', 'verified', true from channels where tenant_id = $1 limit 1`,
      [t.id],
    );
    const token = res.body.ownerInvitation.inviteUrl.split('#token=')[1];
    await request(app.getHttpServer())
      .post('/v1/auth/invitations/accept')
      .set(CSRF)
      .send({ token, displayName: 'S', password: 'suspend-me-password' });
    const owner = await login(app, 'owner@suspend-me.test', 'merchant', 'suspend-me-password');
    expect((await owner.get('/v1/admin/home').set('x-tenant-id', t.id)).status).toBe(200);
    expect(
      (await request(app.getHttpServer()).get('/v1/storefront/config').set('Host', 'suspend-me.localhost'))
        .status,
    ).toBe(200);

    const noReason = await platform
      .post(`/v1/platform/tenants/${t.id}/suspend`)
      .set(CSRF)
      .send({ version: t.version, reason: 'no' });
    expect(noReason.status).toBe(400);
    const suspended = await platform
      .post(`/v1/platform/tenants/${t.id}/suspend`)
      .set(CSRF)
      .send({ version: t.version, reason: 'Unpaid invoice (test)' });
    expect(suspended.status).toBe(200);
    expect(suspended.body).toMatchObject({ status: 'suspended', suspendedReason: 'Unpaid invoice (test)' });

    const blocked = await owner.get('/v1/admin/home').set('x-tenant-id', t.id);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('TENANT_SUSPENDED');
    expect(
      (await request(app.getHttpServer()).get('/v1/storefront/config').set('Host', 'suspend-me.localhost'))
        .status,
    ).toBe(404);
    const again = await platform
      .post(`/v1/platform/tenants/${t.id}/suspend`)
      .set(CSRF)
      .send({ version: suspended.body.version, reason: 'Twice over' });
    expect(again.body.code).toBe('INVALID_STATE_TRANSITION');
    const stale = await platform
      .post(`/v1/platform/tenants/${t.id}/reactivate`)
      .set(CSRF)
      .send({ version: t.version, reason: 'Stale version' });
    expect(stale.body.code).toBe('VERSION_CONFLICT');

    const back = await platform
      .post(`/v1/platform/tenants/${t.id}/reactivate`)
      .set(CSRF)
      .send({ version: suspended.body.version, reason: 'Invoice paid (test)' });
    expect(back.body.status).toBe('active');
    expect((await owner.get('/v1/admin/home').set('x-tenant-id', t.id)).status).toBe(200);

    const audit = await ownerPool.query(
      `select action, reason from audit_events where tenant_id = $1 and action like 'tenant.%' order by created_at`,
      [t.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'tenant.provisioned',
      'tenant.suspended',
      'tenant.reactivated',
    ]);
    expect(audit.rows[1].reason).toBe('Unpaid invoice (test)');
    const events = await ownerPool.query(
      `select event_type from outbox_events where tenant_id = $1 order by occurred_at`,
      [t.id],
    );
    expect(events.rows.map((r) => r.event_type)).toEqual([
      'TenantProvisioned',
      'MembershipChanged',
      'TenantSuspended',
      'TenantReactivated',
    ]);
  });
});

describe('entitlements (ADR-006)', () => {
  it('overrides change effective features, navigation-relevant features and channel rules, with audit', async () => {
    const northwind = await tenantId('northwind-general');
    const before = await platform.get(`/v1/platform/tenants/${northwind}/entitlements`);
    expect(before.body.features.find((f: { key: string }) => f.key === 'b2b_storefront')).toMatchObject({
      presetDefault: false,
      override: null,
      effective: false,
    });
    const noReason = await platform
      .put(`/v1/platform/tenants/${northwind}/entitlements`)
      .set(CSRF)
      .send({ overrides: { b2b_storefront: true } });
    expect(noReason.status).toBe(400);
    const res = await platform
      .put(`/v1/platform/tenants/${northwind}/entitlements`)
      .set(CSRF)
      .send({ overrides: { b2b_storefront: true }, reason: 'Pilot wholesale channel' });
    expect(res.body.features.find((f: { key: string }) => f.key === 'b2b_storefront')).toMatchObject({
      override: true,
      effective: true,
    });

    const owner = await login(app, 'owner@northwind.demo');
    const ctx = await owner.get('/v1/admin/context').set('x-tenant-id', northwind);
    expect(ctx.body.features).toContain('b2b_storefront');
    expect(await auditCount(northwind, 'tenant.entitlements_changed')).toBe(1);

    await platform
      .put(`/v1/platform/tenants/${northwind}/entitlements`)
      .set(CSRF)
      .send({ overrides: { b2b_storefront: null }, reason: 'End of pilot' });
    const after = await owner.get('/v1/admin/context').set('x-tenant-id', northwind);
    expect(after.body.features).not.toContain('b2b_storefront');
  });

  it('rejects unknown feature keys', async () => {
    const northwind = await tenantId('northwind-general');
    const res = await platform
      .put(`/v1/platform/tenants/${northwind}/entitlements`)
      .set(CSRF)
      .send({ overrides: { teleportation: true }, reason: 'Nope nope' });
    expect(res.status).toBe(400);
  });
});

describe('platform audit', () => {
  it('includes platform-level sign-ins and tenant events, filterable by tenant', async () => {
    const all = await platform.get('/v1/platform/audit-events?action=auth.login&limit=5');
    expect(all.body.items.length).toBeGreaterThan(0);
    expect(all.body.items[0].tenantId).toBeNull();
    const aurum = await tenantId('aurum-wholesale');
    const scoped = await platform.get(`/v1/platform/audit-events?tenantId=${aurum}`);
    expect(scoped.body.items.every((e: { tenantId: string }) => e.tenantId === aurum)).toBe(true);
  });
});

describe('storefront resolver (F-09)', () => {
  const sf = () => request(app.getHttpServer()).get('/v1/storefront/config');

  it('resolves a verified domain (port ignored) to the channel brand config', async () => {
    const res = await sf().set('Host', 'lumiere.localhost:3200');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tenant: { slug: 'lumiere-fine', isDemo: true },
      channel: { type: 'b2c_storefront' },
      currency: 'INR',
      hostname: 'lumiere.localhost',
    });
    expect(res.body.theme.fontFamily).toBe('serif');
    expect(res.body).not.toHaveProperty('tenant.id');
  });

  it('never resolves unverified or unknown domains', async () => {
    expect((await sf().set('Host', 'pending-aurum.localhost')).body.code).toBe('STOREFRONT_NOT_FOUND');
    expect((await sf().set('Host', 'nobody.localhost')).status).toBe(404);
    expect((await sf().set('Host', 'bad host!')).status).toBe(404);
  });

  it('honours X-Storefront-Host only with the gateway key', async () => {
    const spoof = await sf().set('Host', 'nobody.localhost').set('X-Storefront-Host', 'lumiere.localhost');
    expect(spoof.status).toBe(404);
    const wrongKey = await sf()
      .set('Host', 'nobody.localhost')
      .set('X-Storefront-Host', 'lumiere.localhost')
      .set('X-Storefront-Key', 'x'.repeat(48));
    expect(wrongKey.status).toBe(404);
    const trusted = await sf()
      .set('Host', 'nobody.localhost')
      .set('X-Storefront-Host', 'lumiere.localhost')
      .set('X-Storefront-Key', process.env.STOREFRONT_GATEWAY_KEY!);
    expect(trusted.status).toBe(200);
  });

  it('inactive channels do not resolve', async () => {
    const lumiere = await tenantId('lumiere-fine');
    await ownerPool.query(`update channels set status = 'inactive' where tenant_id = $1`, [lumiere]);
    try {
      expect((await sf().set('Host', 'lumiere.localhost')).status).toBe(404);
    } finally {
      await ownerPool.query(`update channels set status = 'active' where tenant_id = $1`, [lumiere]);
    }
  });
});
