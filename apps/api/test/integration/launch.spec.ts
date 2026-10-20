import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { API_ROUTES } from '@uc/contracts';
import { requireEnv } from '@uc/db';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditCount,
  CSRF,
  createMember,
  login,
  ownerPool,
  startApp,
  tenantId,
  uniqueEmail,
  type Agent,
} from '../helpers';

/** Phase 12 acceptance (L-01 … L-07): plans and limits, setup checklist, support access, pilot checklist, sweeps. */
let app: INestApplication;
let northwind: string;
let platformOwner: Agent;
let platformSupport: Agent;
let fresh: string;
let freshOwner: Agent;
let freshOwnerEmail: string;

function scoped(agent: Agent, tenant: string) {
  return {
    get: (p: string) => agent.get(p).set('x-tenant-id', tenant),
    post: (p: string, k?: string) => {
      const r = agent.post(p).set('x-tenant-id', tenant).set(CSRF);
      return k ? r.set('idempotency-key', k) : r;
    },
    put: (p: string) => agent.put(p).set('x-tenant-id', tenant).set(CSRF),
    patch: (p: string) => agent.patch(p).set('x-tenant-id', tenant).set(CSRF),
  };
}

let seq = 0;
const uid = () => `${Date.now().toString(36)}${++seq}`;
const key = () => `key-${uid()}-${Math.random().toString(36).slice(2, 8)}`;
const count = async (q: string, params: unknown[]) => Number((await ownerPool.query(q, params)).rows[0].n);
const savePlan = (body: Record<string, unknown>, planKey: string) =>
  platformOwner.put(`/v1/platform/plans/${planKey}`).set(CSRF).send(body);
const limits = (l: Partial<Record<string, number | null>>) => ({
  products: null,
  staffSeats: null,
  locations: null,
  domains: null,
  ordersPerMonth: null,
  ...l,
});
const assign = (tenant: string, planKey: string) =>
  platformOwner
    .put(`/v1/platform/tenants/${tenant}/plan`)
    .set(CSRF)
    .send({ planKey, reason: 'Phase 12 acceptance test' });

beforeAll(async () => {
  app = await startApp();
  northwind = await tenantId('northwind-general');
  platformOwner = await login(app, 'platform@uc.local', 'platform');
  platformSupport = await login(app, 'support@uc.local', 'platform');
  // A freshly provisioned merchant (general commerce) with known, small usage.
  const slug = `launch-${uid()}`.toLowerCase();
  const created = await platformOwner
    .post('/v1/platform/tenants')
    .set(CSRF)
    .set('idempotency-key', key())
    .send({
      slug,
      displayName: 'Launch Test Store',
      legalName: 'Launch Test Store Pvt Ltd',
      preset: 'general_commerce',
      countryCode: 'IN',
      defaultCurrency: 'INR',
      timezone: 'Asia/Kolkata',
      defaultLocale: 'en-IN',
      contactEmail: 'contact@launch.test',
      ownerEmail: uniqueEmail('launch-owner'),
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.tenant.planKey).toBe('pilot');
  fresh = created.body.tenant.id as string;
  await ownerPool.query("update tenants set status = 'active' where id = $1", [fresh]);
  const owner = await createMember(fresh, ['owner']);
  freshOwnerEmail = owner.email;
  freshOwner = await login(app, owner.email);
});

afterAll(async () => {
  await ownerPool.query("update tenants set plan_key = 'pilot' where id = $1", [northwind]);
  await app.close();
});

describe('plans (L-01)', () => {
  it('only plan managers edit plans; versions, validation and audit are enforced', async () => {
    const k = `t_${uid()}`.toLowerCase().replace(/[^a-z0-9_]/g, '');
    const body = { name: 'Tiny', description: 'test', limits: limits({ products: 1 }) };
    expect((await platformSupport.put(`/v1/platform/plans/${k}`).set(CSRF).send(body)).status).toBe(403);
    const created = await savePlan(body, k);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({ key: k, version: 0, tenantCount: 0, limits: { products: 1 } });
    expect((await savePlan(body, k)).status).toBe(409); // exists, no version
    expect((await savePlan({ ...body, version: 5 }, k)).status).toBe(409);
    const updated = await savePlan({ ...body, name: 'Tiny 2', version: 0 }, k);
    expect(updated.body).toMatchObject({ name: 'Tiny 2', version: 1 });
    expect((await savePlan({ ...body, limits: { products: -1 } }, k)).status).toBe(400);
    const pilot = (await platformOwner.get('/v1/platform/plans')).body.items.find(
      (p: { key: string }) => p.key === 'pilot',
    );
    expect(
      (
        await savePlan(
          { name: 'Pilot', limits: pilot.limits, status: 'retired', version: pilot.version },
          'pilot',
        )
      ).status,
    ).toBe(422);
    expect(
      await count(
        "select count(*) n from audit_events where action in ('plan.created','plan.updated') and entity_id = $1",
        [k],
      ),
    ).toBe(2);

    // Assigning: reason required, unknown/retired plans refused, audited on the tenant.
    expect(
      (await platformOwner.put(`/v1/platform/tenants/${fresh}/plan`).set(CSRF).send({ planKey: k })).status,
    ).toBe(400);
    expect((await assign(fresh, 'no_such_plan')).status).toBe(422);
    await savePlan({ ...body, status: 'retired', version: 1 }, k).expect(200);
    expect((await assign(fresh, k)).status).toBe(422);
    const before = await auditCount(fresh, 'tenant.plan_changed');
    expect((await assign(fresh, 'starter')).status).toBe(200);
    expect(await auditCount(fresh, 'tenant.plan_changed')).toBe(before + 1);
    await assign(fresh, 'pilot').expect(200);
  });
});

describe('usage and limits (L-02, L-03)', () => {
  it('usage equals independent counts; merchants see only their own plan', async () => {
    const u = (await scoped(freshOwner, fresh).get('/v1/admin/plan').expect(200)).body;
    expect(u).toMatchObject({ tenantId: fresh, plan: { key: 'pilot' }, billing: 'not_connected' });
    const line = (k: string) => u.usage.find((l: { key: string }) => l.key === k);
    expect(line('products').used).toBe(
      await count("select count(*) n from products where tenant_id = $1 and status <> 'archived'", [fresh]),
    );
    expect(line('locations').used).toBe(
      await count("select count(*) n from locations where tenant_id = $1 and status = 'active'", [fresh]),
    );
    expect(line('staffSeats').used).toBe(
      (await count("select count(*) n from memberships where tenant_id = $1 and status = 'active'", [
        fresh,
      ])) +
        (await count(
          "select count(*) n from invitations where tenant_id = $1 and status = 'pending' and expires_at > now()",
          [fresh],
        )),
    );
    expect(line('products')).toMatchObject({ hard: true, limit: null, state: 'unlimited' });
    expect(line('ordersPerMonth').hard).toBe(false);
    const platformView = (await platformOwner.get(`/v1/platform/tenants/${fresh}/usage`).expect(200)).body;
    expect(platformView.usage).toEqual(u.usage);
    // Another merchant's owner cannot read this plan.
    const nwOwner = await login(app, 'owner@northwind.demo');
    expect((await nwOwner.get('/v1/admin/plan').set('x-tenant-id', fresh)).status).toBe(403);
  });

  it('hard limits refuse with 422 PLAN_LIMIT_REACHED, also for concurrent creates', async () => {
    const s = scoped(freshOwner, fresh);
    const u = (await s.get('/v1/admin/plan')).body;
    const used = (k: string) => u.usage.find((l: { key: string }) => l.key === k).used as number;
    const k = `cap_${uid()}`.toLowerCase().replace(/[^a-z0-9_]/g, '');
    await savePlan(
      {
        name: 'Capped',
        limits: limits({
          products: used('products') + 1,
          staffSeats: used('staffSeats'),
          locations: used('locations'),
          domains: used('domains'),
        }),
      },
      k,
    ).expect(200);
    await assign(fresh, k).expect(200);
    try {
      // Three concurrent creates for one free slot: exactly one wins.
      const results = await Promise.all(
        [1, 2, 3].map((i) =>
          s.post('/v1/admin/products').send({ title: `Cap ${i}`, variants: [{ sku: `CAP-${uid()}-${i}` }] }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 422, 422]);
      const refused = results.find((r) => r.status === 422)!;
      expect(refused.body.code).toBe('PLAN_LIMIT_REACHED');
      expect(refused.body.details).toMatchObject({ limit: 'products', max: used('products') + 1 });

      const loc = await s
        .post('/v1/admin/locations')
        .send({ code: `l${uid()}`.toLowerCase().slice(0, 20), name: 'Extra', type: 'warehouse' });
      expect(loc.status, JSON.stringify(loc.body)).toBe(422);
      expect(loc.body.code).toBe('PLAN_LIMIT_REACHED');
      const viewer = (
        await ownerPool.query("select id from roles where tenant_id = $1 and key = 'viewer'", [fresh])
      ).rows[0].id as string;
      const inv = await s
        .post('/v1/admin/invitations', key())
        .send({ email: uniqueEmail('cap'), roleIds: [viewer] });
      expect(inv.status, JSON.stringify(inv.body)).toBe(422);
      expect(inv.body.code).toBe('PLAN_LIMIT_REACHED');

      const after = (await s.get('/v1/admin/plan')).body;
      expect(after.usage.find((l: { key: string }) => l.key === 'products')).toMatchObject({ state: 'at' });
    } finally {
      await assign(fresh, 'pilot').expect(200);
    }
  });

  it('orders over the soft monthly limit still succeed and show as over', async () => {
    const nw = scoped(await login(app, 'owner@northwind.demo'), northwind);
    const k = `soft_${uid()}`.toLowerCase().replace(/[^a-z0-9_]/g, '');
    await savePlan({ name: 'Soft', limits: limits({ ordersPerMonth: 0 }) }, k).expect(200);
    await assign(northwind, k).expect(200);
    try {
      const sku = `SOFT-${uid()}`.toUpperCase();
      const p = await nw.post('/v1/admin/products').send({ title: `Soft ${sku}`, variants: [{ sku }] });
      await nw.patch(`/v1/admin/products/${p.body.id}`).send({ version: 0, status: 'active' }).expect(200);
      const variantId = p.body.variants[0].id as string;
      const book = (await nw.get('/v1/admin/pricing/books')).body.items[0].id;
      await nw
        .put(`/v1/admin/pricing/books/${book}/list-prices`)
        .send({ items: [{ variantId, amount: '10.00' }] })
        .expect(200);
      const main = (
        await ownerPool.query('select id from locations where tenant_id = $1 order by created_at limit 1', [
          northwind,
        ])
      ).rows[0].id;
      await nw
        .post('/v1/admin/inventory/receipts', key())
        .send({ locationId: main, lines: [{ variantId, quantity: '2' }] })
        .expect(201);
      const o = await nw
        .post('/v1/admin/orders', key())
        .send({ contact: { name: 'Soft', email: 'soft@example.test' }, lines: [{ variantId }] });
      expect(o.status, JSON.stringify(o.body)).toBe(201);
      const usage = (await nw.get('/v1/admin/plan')).body;
      expect(usage.usage.find((l: { key: string }) => l.key === 'ordersPerMonth')).toMatchObject({
        limit: 0,
        hard: false,
        state: 'over',
      });
    } finally {
      await assign(northwind, 'pilot').expect(200);
    }
  });
});

describe('setup checklist (L-04)', () => {
  it('steps reflect real records and preset features', async () => {
    const s = scoped(freshOwner, fresh);
    const before = (await s.get('/v1/admin/setup').expect(200)).body;
    const step = (c: { steps: { key: string; done: boolean }[] }, k: string) =>
      c.steps.find((x) => x.key === k);
    expect(step(before, 'metal_rates')).toBeUndefined(); // general commerce
    expect(step(before, 'location')?.done).toBe(true); // provisioned main location
    expect(step(before, 'first_order')?.done).toBe(false);
    const activeBefore = await count(
      "select count(*) n from products where tenant_id = $1 and status = 'active'",
      [fresh],
    );
    expect(step(before, 'products')?.done).toBe(activeBefore > 0);
    const p = await s
      .post('/v1/admin/products')
      .send({ title: 'Setup item', variants: [{ sku: `SET-${uid()}` }] });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    await s.patch(`/v1/admin/products/${p.body.id}`).send({ version: 0, status: 'active' }).expect(200);
    const after = (await s.get('/v1/admin/setup')).body;
    expect(step(after, 'products')?.done).toBe(true);
    expect(after.requiredDone).toBeGreaterThanOrEqual(before.requiredDone);
    expect(after.requiredTotal).toBe(after.steps.filter((x: { optional: boolean }) => !x.optional).length);

    const aurum = await tenantId('aurum-wholesale');
    const au = (await (await login(app, 'owner@aurum.demo')).get('/v1/admin/setup').set('x-tenant-id', aurum))
      .body;
    expect(step(au, 'metal_rates')).toBeDefined();
  });
});

describe('support access (L-05)', () => {
  const requestAccess = (body: Record<string, unknown>) =>
    platformSupport.post(`/v1/platform/tenants/${fresh}/support-grants`).set(CSRF).send(body);

  it('request → owner approval → requester-only, read-only, audited session → revoke', async () => {
    expect((await requestAccess({ reason: 'short' })).status).toBe(400);
    expect(
      (await requestAccess({ reason: 'Customer reports wrong stock on SKU A-1', durationMinutes: 500 }))
        .status,
    ).toBe(400);
    const g = await requestAccess({
      reason: 'Customer reports wrong stock on SKU A-1',
      ticketRef: 'T-42',
      durationMinutes: 30,
    });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    expect(g.body).toMatchObject({
      status: 'requested',
      durationMinutes: 30,
      ticketRef: 'T-42',
      expiresAt: null,
    });
    const grantId = g.body.id as string;
    expect(
      await count("select count(*) n from staff_notifications where tenant_id = $1 and source = 'support'", [
        fresh,
      ]),
    ).toBeGreaterThan(0);

    // Not startable before approval.
    expect(
      (await platformSupport.post(`/v1/platform/support-grants/${grantId}/start`).set(CSRF)).status,
    ).toBe(409);
    // Admins cannot approve (owner-only permission); the owner can.
    const admin = await createMember(fresh, ['admin']);
    const adminAgent = await login(app, admin.email);
    expect(
      (
        await scoped(adminAgent, fresh)
          .post(`/v1/admin/support-grants/${grantId}/approve`)
          .send({ version: 0 })
      ).status,
    ).toBe(403);
    const owner = scoped(freshOwner, fresh);
    expect(
      (await owner.post(`/v1/admin/support-grants/${grantId}/approve`).send({ version: 3 })).status,
    ).toBe(409);
    const approved = await owner
      .post(`/v1/admin/support-grants/${grantId}/approve`)
      .send({ version: 0, note: 'ok' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('approved');
    const minutes = (Date.parse(approved.body.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(28);
    expect(minutes).toBeLessThanOrEqual(30);
    expect(
      (await owner.post(`/v1/admin/support-grants/${grantId}/approve`).send({ version: 1 })).status,
    ).toBe(409);

    // Only the requesting operator can start it.
    expect((await platformOwner.post(`/v1/platform/support-grants/${grantId}/start`).set(CSRF)).status).toBe(
      403,
    );
    const started = await platformSupport.post(`/v1/platform/support-grants/${grantId}/start`).set(CSRF);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const code = /#code=(.+)$/.exec(started.body.merchantAdminUrl)?.[1];
    expect(code).toBeTruthy();

    // The merchant admin redeems the one-time code on its own origin.
    const support = request.agent(app.getHttpServer());
    const redeemed = await support.post('/v1/auth/support/redeem').set(CSRF).send({ code });
    expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(200);
    expect(redeemed.body.tenantId).toBe(fresh);
    const again = request.agent(app.getHttpServer());
    expect((await again.post('/v1/auth/support/redeem').set(CSRF).send({ code })).status).toBe(401);

    const me = (await support.get('/v1/auth/me?audience=merchant').expect(200)).body;
    expect(me.support).toMatchObject({ grantId, tenantId: fresh, readOnly: true });
    expect(me.memberships).toHaveLength(1);
    expect(me.memberships[0].roles[0].key).toBe('support');

    const sup = scoped(support, fresh);
    const context = (await sup.get('/v1/admin/context').expect(200)).body;
    expect(context.support).toMatchObject({ grantId, readOnly: true });
    expect(context.membership.roles).toEqual([{ id: grantId, key: 'support', name: 'Support (read-only)' }]);
    expect(context.permissions.every((p: string) => p.endsWith('.read'))).toBe(true);
    expect(context.nav.some((n: { key: string }) => n.key === 'settings-support')).toBe(false);
    expect((await sup.get('/v1/admin/products')).status).toBe(200);
    expect((await sup.get('/v1/admin/customers')).status).toBe(403); // no personal data
    expect((await sup.get('/v1/admin/audit-events')).status).toBe(403);
    const write = await sup
      .post('/v1/admin/products')
      .send({ title: 'x', variants: [{ sku: `SUP-${uid()}` }] });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('SUPPORT_READ_ONLY');
    expect((await support.get('/v1/admin/products').set('x-tenant-id', northwind)).status).toBe(403);
    // Account security cannot be changed through a support session.
    expect((await support.post('/v1/auth/mfa/enroll').set(CSRF)).status).toBe(401);

    expect(
      await count(
        "select count(*) n from audit_events where tenant_id = $1 and action = 'support.request' and entity_id = $2",
        [fresh, grantId],
      ),
    ).toBeGreaterThanOrEqual(3);
    const listed = (await owner.get('/v1/admin/support-grants').expect(200)).body.items.find(
      (x: { id: string }) => x.id === grantId,
    );
    expect(listed.requestCount).toBeGreaterThanOrEqual(3);
    expect(listed.startedAt).not.toBeNull();

    // Owner revokes: the session ends immediately.
    const revoked = await owner.post(`/v1/admin/support-grants/${grantId}/revoke`);
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body.status).toBe('revoked');
    expect((await sup.get('/v1/admin/products')).status).toBe(401);
    expect(await auditCount(fresh, 'support.revoked')).toBeGreaterThan(0);
  });

  it('expiry ends access; denial cannot be started', async () => {
    const owner = scoped(freshOwner, fresh);
    const g = (await requestAccess({ reason: 'Checking an import failure for the merchant' })).body;
    await owner.post(`/v1/admin/support-grants/${g.id}/approve`).send({ version: 0 }).expect(200);
    const started = (
      await platformSupport.post(`/v1/platform/support-grants/${g.id}/start`).set(CSRF).expect(200)
    ).body;
    const support = request.agent(app.getHttpServer());
    await support
      .post('/v1/auth/support/redeem')
      .set(CSRF)
      .send({ code: /#code=(.+)$/.exec(started.merchantAdminUrl)![1] })
      .expect(200);
    await support.get('/v1/admin/products').set('x-tenant-id', fresh).expect(200);
    await ownerPool.query(
      "update support_grants set expires_at = now() - interval '1 second' where id = $1",
      [g.id],
    );
    expect((await support.get('/v1/admin/products').set('x-tenant-id', fresh)).status).toBe(401);
    const list = (await platformSupport.get(`/v1/platform/support-grants?tenantId=${fresh}`).expect(200)).body
      .items;
    expect(list.find((x: { id: string }) => x.id === g.id).status).toBe('expired');

    const d = (await requestAccess({ reason: 'Second look at the same import problem' })).body;
    const denied = await owner
      .post(`/v1/admin/support-grants/${d.id}/deny`)
      .send({ version: 0, note: 'Not now' });
    expect(denied.body).toMatchObject({ status: 'denied', decisionNote: 'Not now' });
    expect((await platformSupport.post(`/v1/platform/support-grants/${d.id}/start`).set(CSRF)).status).toBe(
      409,
    );
    expect(freshOwnerEmail).toBeTruthy();
  });
});

describe('pilot connector checklist (L-06)', () => {
  it('reflects real sync state and never claims production support', async () => {
    const { rows } = await ownerPool.query(
      'select c.id, c.tenant_id from connections c order by c.created_at limit 1',
    );
    expect(rows.length).toBeGreaterThan(0);
    const conn = rows[0] as { id: string; tenant_id: string };
    const ownerEmail = (
      await ownerPool.query(
        `select u.email from memberships m join users u on u.id = m.user_id
         join membership_roles mr on mr.membership_id = m.id join roles r on r.id = mr.role_id
         where m.tenant_id = $1 and r.key = 'owner' limit 1`,
        [conn.tenant_id],
      )
    ).rows[0].email as string;
    const agent = await login(app, ownerEmail);
    const c = (
      await agent
        .get(`/v1/admin/integrations/connections/${conn.id}/pilot-checklist`)
        .set('x-tenant-id', conn.tenant_id)
        .expect(200)
    ).body;
    expect(c.productionSupported).toBe(false);
    expect(c.steps.find((s: { key: string }) => s.key === 'production').state).toBe('blocked');
    const committed = await count(
      "select count(*) n from sync_jobs where connection_id = $1 and status in ('committed','partially_committed')",
      [conn.id],
    );
    expect(c.steps.find((s: { key: string }) => s.key === 'full_import').state).toBe(
      committed > 0 ? 'done' : 'todo',
    );
    expect(
      (
        await agent
          .get(`/v1/admin/integrations/connections/${randomUUID()}/pilot-checklist`)
          .set('x-tenant-id', conn.tenant_id)
      ).status,
    ).toBe(404);
  });
});

describe('multi-tenant hardening (L-07)', () => {
  const pathOf = (p: string) => p.replace(/\{[^}]+\}/g, () => randomUUID());

  it('every admin route needs a session, then membership of the named merchant', async () => {
    const admin = API_ROUTES.filter((r) => r.scope === 'admin');
    expect(admin.length).toBeGreaterThan(100);
    const outsider = await login(app, 'owner@northwind.demo');
    const failures: string[] = [];
    for (const r of admin) {
      const path = pathOf(r.path);
      const anon = await request(app.getHttpServer())[r.method](path).set(CSRF).set('x-tenant-id', fresh);
      if (anon.status !== 401) failures.push(`anon ${r.method} ${r.path} → ${anon.status}`);
      const other = await outsider[r.method](path).set(CSRF).set('x-tenant-id', fresh);
      if (other.status !== 403) failures.push(`non-member ${r.method} ${r.path} → ${other.status}`);
    }
    expect(failures).toEqual([]);
  }, 180_000);

  it('every platform route refuses anonymous and merchant sessions', async () => {
    const platform = API_ROUTES.filter((r) => r.scope === 'platform');
    const merchant = await login(app, 'owner@northwind.demo');
    const failures: string[] = [];
    for (const r of platform) {
      const path = pathOf(r.path).replace(/plans\/[0-9a-f-]+$/, 'plans/some_plan');
      const anon = await request(app.getHttpServer())[r.method](path).set(CSRF);
      if (anon.status !== 401) failures.push(`anon ${r.method} ${r.path} → ${anon.status}`);
      const m = await merchant[r.method](path).set(CSRF);
      if (m.status !== 401) failures.push(`merchant ${r.method} ${r.path} → ${m.status}`);
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('RLS: a tenant transaction sees no other tenant’s rows in any tenant table', async () => {
    const app_ = new Pool({ connectionString: requireEnv('TEST_DATABASE_URL'), max: 1 });
    try {
      const tables = (
        await ownerPool.query(
          "select distinct tablename from pg_policies where schemaname = 'public' and qual like '%uc_tenant_visible(tenant_id)%' order by 1",
        )
      ).rows.map((r) => r.tablename as string);
      expect(tables.length).toBeGreaterThan(50);
      const client = await app_.connect();
      const leaks: string[] = [];
      let otherRows = 0;
      try {
        await client.query('begin');
        await client.query("select set_config('app.tenant_id', $1, true)", [northwind]);
        for (const t of tables) {
          const seen = await client.query(`select count(*)::int n from "${t}" where tenant_id <> $1`, [
            northwind,
          ]);
          if (seen.rows[0].n !== 0) leaks.push(`${t}: ${seen.rows[0].n}`);
          otherRows += await count(`select count(*) n from "${t}" where tenant_id <> $1`, [northwind]);
        }
        await client.query('rollback');
      } finally {
        client.release();
      }
      expect(leaks).toEqual([]);
      expect(otherRows).toBeGreaterThan(0); // the sweep is meaningful: other tenants do have rows
    } finally {
      await app_.end();
    }
  });
});
