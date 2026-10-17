import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditCount, CSRF, login, ownerPool, startApp, tenantId, type Agent } from '../helpers';

let app: INestApplication;
let northwind: string;
let aurum: string;
let owner: {
  get: (p: string) => ReturnType<Agent['get']>;
  patch: (p: string) => ReturnType<Agent['patch']>;
  post: (p: string) => ReturnType<Agent['post']>;
};

beforeAll(async () => {
  app = await startApp();
  northwind = await tenantId('northwind-general');
  aurum = await tenantId('aurum-wholesale');
  const agent = await login(app, 'owner@northwind.demo');
  owner = {
    get: (p) => agent.get(p).set('x-tenant-id', northwind),
    patch: (p) => agent.patch(p).set('x-tenant-id', northwind).set(CSRF),
    post: (p) => agent.post(p).set('x-tenant-id', northwind).set(CSRF),
  };
});
afterAll(() => app.close());

describe('general settings: optimistic locking + audit (F-06, F-04)', () => {
  it('updates with the current version, bumps it, and audits only changed fields', async () => {
    const current = (await owner.get('/v1/admin/settings/general')).body;
    const before = await auditCount(northwind, 'settings.general.updated');
    const res = await owner
      .patch('/v1/admin/settings/general')
      .send({ version: current.version, contactPhone: '+44 20 7946 0000' });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(current.version + 1);
    expect(res.body.contactPhone).toBe('+44 20 7946 0000');
    expect(await auditCount(northwind, 'settings.general.updated')).toBe(before + 1);
    const { rows } = await ownerPool.query(
      `select old_values, new_values, correlation_id from audit_events where tenant_id = $1 and action = 'settings.general.updated' order by created_at desc limit 1`,
      [northwind],
    );
    expect(rows[0].new_values).toEqual({ contactPhone: '+44 20 7946 0000' });
    expect(rows[0].correlation_id).toBe(res.headers['x-correlation-id']);
  });

  it('rejects a stale version with 409 VERSION_CONFLICT and leaves data untouched', async () => {
    const current = (await owner.get('/v1/admin/settings/general')).body;
    await owner
      .patch('/v1/admin/settings/general')
      .send({ version: current.version, displayName: 'Northwind General Store (DEMO)' });
    const stale = await owner
      .patch('/v1/admin/settings/general')
      .send({ version: current.version, displayName: 'Lost update' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect((await owner.get('/v1/admin/settings/general')).body.displayName).toBe(
      'Northwind General Store (DEMO)',
    );
  });

  it('validates fields server-side with actionable paths', async () => {
    const res = await owner
      .patch('/v1/admin/settings/general')
      .send({ version: 0, timezone: 'Mars/Olympus', contactEmail: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.details.map((d: { path: string }) => d.path).sort()).toEqual([
      'contactEmail',
      'timezone',
    ]);
  });

  it('ignores attempts to change platform-owned fields (currency/country) via merchant settings', async () => {
    const current = (await owner.get('/v1/admin/settings/general')).body;
    const res = await owner
      .patch('/v1/admin/settings/general')
      .send({ version: current.version, defaultCurrency: 'USD', countryCode: 'US' });
    expect(res.status).toBe(200);
    expect(res.body.defaultCurrency).toBe('GBP');
    expect(res.body.countryCode).toBe('GB');
  });
});

describe('feature presets in context (F-12)', () => {
  it('general-commerce tenant has no jewellery features', async () => {
    const ctx = (await owner.get('/v1/admin/context')).body;
    expect(ctx.tenant.preset).toBe('general_commerce');
    expect(ctx.features).not.toContain('jewellery');
    expect(ctx.features).not.toContain('metal_rates');
  });

  it('channel types require entitlement', async () => {
    const stores = (await owner.get('/v1/admin/stores')).body.items;
    const res = await owner
      .post('/v1/admin/channels')
      .send({ storeId: stores[0].id, code: 'wholesale', name: 'Wholesale', type: 'b2b_storefront' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'FEATURE_NOT_ENTITLED', details: { feature: 'b2b_storefront' } });
  });
});

describe('stores & channels', () => {
  it('creates a store inheriting regional defaults, rejects duplicate codes per tenant', async () => {
    const res = await owner.post('/v1/admin/stores').send({ code: 'outlet', name: 'Outlet store' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      code: 'outlet',
      defaultCurrency: 'GBP',
      timezone: 'Europe/London',
      version: 0,
      status: 'active',
    });
    const dup = await owner.post('/v1/admin/stores').send({ code: 'outlet', name: 'Again' });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'DUPLICATE', details: { field: 'code' } });
    // The same code is fine in another tenant.
    const aurumOwner = await login(app, 'owner@aurum.demo');
    expect(
      (
        await aurumOwner
          .post('/v1/admin/stores')
          .set('x-tenant-id', aurum)
          .set(CSRF)
          .send({ code: 'outlet', name: 'Aurum outlet' })
      ).status,
    ).toBe(201);
  });

  it('creates and re-themes a channel with validation and audit', async () => {
    const store = (await owner.get('/v1/admin/stores?q=outlet')).body.items[0];
    const created = await owner
      .post('/v1/admin/channels')
      .send({ storeId: store.id, code: 'popup', name: 'Pop-up shop', type: 'pos' });
    expect(created.status).toBe(201);
    expect(created.body.theme.brandName).toContain('Northwind');
    const bad = await owner
      .patch(`/v1/admin/channels/${created.body.id}`)
      .send({ version: 0, theme: { ...created.body.theme, primaryColor: 'blue' } });
    expect(bad.status).toBe(400);
    expect(bad.body.details[0].path).toBe('theme.primaryColor');
    const ok = await owner
      .patch(`/v1/admin/channels/${created.body.id}`)
      .send({ version: 0, theme: { ...created.body.theme, primaryColor: '#123456' } });
    expect(ok.status).toBe(200);
    expect(ok.body.theme.primaryColor).toBe('#123456');
    expect(await auditCount(northwind, 'channel.updated')).toBeGreaterThan(0);
  });
});

describe('locations: validation, hierarchy and keyset pagination', () => {
  it('enforces bin placement rules', async () => {
    const orphan = await owner
      .post('/v1/admin/locations')
      .send({ code: 'bin-a1', name: 'Bin A1', type: 'bin' });
    expect(orphan.status).toBe(400);
    const wh = (await owner.get('/v1/admin/locations?q=main-wh')).body.items[0];
    const bin = await owner
      .post('/v1/admin/locations')
      .send({ code: 'bin-a1', name: 'Bin A1', type: 'bin', parentId: wh.id });
    expect(bin.status).toBe(201);
    const nested = await owner
      .post('/v1/admin/locations')
      .send({ code: 'bin-a1-x', name: 'Bin in bin', type: 'bin', parentId: bin.body.id });
    expect(nested.status).toBe(400);
  });

  it('pages through all rows exactly once in a stable order', async () => {
    for (let i = 0; i < 27; i++) {
      const code = `page-${String(i).padStart(2, '0')}`;
      expect(
        (await owner.post('/v1/admin/locations').send({ code, name: `Paging ${i}`, type: 'branch' })).status,
      ).toBe(201);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await owner.get(
        `/v1/admin/locations?limit=10&sort=code${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((l: { code: string }) => l.code));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    const total = (
      await ownerPool.query('select count(*)::int as n from locations where tenant_id = $1', [northwind])
    ).rows[0].n;
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect([...seen]).toEqual([...seen].sort());
  });

  it('supports descending createdAt order and filters', async () => {
    const res = await owner.get('/v1/admin/locations?sort=-createdAt&limit=5&q=paging');
    const names = res.body.items.map((l: { name: string }) => l.name);
    expect(names[0]).toBe('Paging 26');
    const branches = await owner.get('/v1/admin/locations?type=bin');
    expect(branches.body.items.every((l: { type: string }) => l.type === 'bin')).toBe(true);
  });

  it('rejects tampered cursors', async () => {
    const res = await owner.get('/v1/admin/locations?cursor=not-a-cursor');
    expect(res.status).toBe(400);
  });

  it('deactivation is a versioned, audited state change', async () => {
    const loc = (await owner.get('/v1/admin/locations?q=page-00')).body.items[0];
    const res = await owner
      .patch(`/v1/admin/locations/${loc.id}`)
      .send({ version: loc.version, status: 'inactive' });
    expect(res.status).toBe(200);
    expect(await auditCount(northwind, 'location.deactivated')).toBe(1);
  });
});

describe('home and audit log', () => {
  it('home figures are live aggregates', async () => {
    const home = (await owner.get('/v1/admin/home')).body;
    const locations = (
      await ownerPool.query('select count(*)::int as n from locations where tenant_id = $1', [northwind])
    ).rows[0].n;
    expect(home.counts.locations).toBe(locations);
    expect(home.setupChecklist.find((c: { key: string }) => c.key === 'locations').done).toBe(true);
    expect(home.recentActivity.length).toBeGreaterThan(0);
  });

  it('audit log filters by entity and never includes other tenants', async () => {
    const res = await owner.get('/v1/admin/audit-events?entityType=location&limit=100');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const e of res.body.items) {
      expect(e.tenantId).toBe(northwind);
      expect(e.entityType).toBe('location');
    }
  });
});

describe('errors and headers', () => {
  it('unknown routes return the standard error envelope', async () => {
    const res = await owner.get('/v1/admin/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', correlationId: expect.any(String) });
  });

  it('echoes a valid inbound correlation id and sets security headers', async () => {
    const res = await owner.get('/v1/admin/home').set('X-Correlation-Id', 'trace-abc-12345');
    expect(res.headers['x-correlation-id']).toBe('trace-abc-12345');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
