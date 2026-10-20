import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { EventEnvelope } from '@uc/contracts';
import { assertPublicUrl, createDb, deliverDueWebhooks, fanOutEvent, requireEnv, systemTx } from '@uc/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stepOf, totpAt } from '../../src/common/totp';
import { DEV_SECRETS_KEY } from '../../src/config/config';
import {
  CSRF,
  createMember,
  login,
  ownerPool,
  startApp,
  tenantId,
  TEST_PASSWORD,
  type Agent,
} from '../helpers';

/** Phase 11 acceptance (P-01 … P-08): webhooks, API keys, MFA, automations, operations health, exports. */
let app: INestApplication;
let northwind: string;
let nwMain: string;
const worker = createDb(requireEnv('TEST_DATABASE_URL'), { max: 2 });
const deliver = (now = new Date()) =>
  deliverDueWebhooks(worker.db, { secretsKey: DEV_SECRETS_KEY, allowPrivate: true, now });

function scoped(agent: Agent, tenant: string) {
  return {
    get: (p: string) => agent.get(p).set('x-tenant-id', tenant),
    post: (p: string, k?: string) => {
      const r = agent.post(p).set('x-tenant-id', tenant).set(CSRF);
      return k ? r.set('idempotency-key', k) : r;
    },
    put: (p: string) => agent.put(p).set('x-tenant-id', tenant).set(CSRF),
    patch: (p: string) => agent.patch(p).set('x-tenant-id', tenant).set(CSRF),
    del: (p: string) => agent.delete(p).set('x-tenant-id', tenant).set(CSRF),
  };
}
type Staff = ReturnType<typeof scoped>;
let nw: Staff;

let seq = 0;
const uid = () => `${Date.now().toString(36)}${++seq}`.toUpperCase();
const key = () => `key-${uid()}-${Math.random().toString(36).slice(2, 8)}`;
const one = async <T = Record<string, unknown>>(q: string, params: unknown[]) =>
  (await ownerPool.query(q, params)).rows[0] as T;

/** A local receiver: records requests, answers with `status`. */
const received: { headers: IncomingHttpHeaders; body: string }[] = [];
let receiverStatus = 200;
let server: Server;
let receiverUrl: string;

/** Confirms a staff order (on account) and returns the OrderConfirmed envelope from the outbox. */
async function confirmedOrderEvent(): Promise<{ orderId: string; event: EventEnvelope }> {
  const sku = `OPS-${uid()}`;
  const p = await nw.post('/v1/admin/products').send({ title: `Ops ${sku}`, variants: [{ sku }] });
  await nw.patch(`/v1/admin/products/${p.body.id}`).send({ version: 0, status: 'active' }).expect(200);
  const variantId = p.body.variants[0].id as string;
  const book = (await nw.get('/v1/admin/pricing/books')).body.items[0].id;
  await nw
    .put(`/v1/admin/pricing/books/${book}/list-prices`)
    .send({ items: [{ variantId, amount: '25.00' }] })
    .expect(200);
  await nw
    .post('/v1/admin/inventory/receipts', key())
    .send({ locationId: nwMain, lines: [{ variantId, quantity: '5' }] })
    .expect(201);
  const o = await nw
    .post('/v1/admin/orders', key())
    .send({ contact: { name: 'Ops', email: 'ops@example.test' }, lines: [{ variantId }] });
  expect(o.body.status, JSON.stringify(o.body)).toBe('confirmed');
  const row = await one<Record<string, unknown>>(
    "select * from outbox_events where tenant_id = $1 and event_type = 'OrderConfirmed' and payload->>'orderId' = $2",
    [northwind, o.body.id],
  );
  const event = EventEnvelope.parse({
    eventId: row.id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    tenantId: row.tenant_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    occurredAt: (row.occurred_at as Date).toISOString(),
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    payload: row.payload,
  });
  return { orderId: o.body.id as string, event };
}
const fanOut = (event: EventEnvelope) => systemTx(worker.db, (tx) => fanOutEvent(tx, event));
const verify = (secret: string, header: string, body: string) => {
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header) ?? [];
  return !!t && createHmac('sha256', secret).update(`${t}.${body}`).digest('hex') === v1;
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.statusCode = receiverStatus;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  receiverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  app = await startApp({ WEBHOOKS_ALLOW_PRIVATE_TARGETS: true });
  northwind = await tenantId('northwind-general');
  nwMain = (
    await one<{ id: string }>('select id from locations where tenant_id = $1 order by created_at limit 1', [
      northwind,
    ])
  ).id;
  nw = scoped(await login(app, 'owner@northwind.demo'), northwind);
});
afterAll(async () => {
  await app.close();
  await worker.close();
  server.close();
});

describe('outbound webhooks (P-01, P-02, P-03)', () => {
  it('delivers subscribed events once, signed; the secret is shown once and stored encrypted', async () => {
    const created = await nw
      .post('/v1/admin/webhooks')
      .send({ name: 'ERP bridge', url: receiverUrl, eventTypes: ['OrderConfirmed'] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { secret, endpoint } = created.body as {
      secret: string;
      endpoint: { id: string; secretHint: string };
    };
    expect(secret).toMatch(/^whsec_/);
    expect(endpoint.secretHint).toBe(`…${secret.slice(-4)}`);
    expect(JSON.stringify((await nw.get('/v1/admin/webhooks')).body)).not.toContain(secret);
    expect(
      (
        await one<{ s: string }>('select secret_sealed as s from webhook_endpoints where id = $1', [
          endpoint.id,
        ])
      ).s,
    ).not.toContain(secret.slice(6));
    received.length = 0;
    const { event } = await confirmedOrderEvent();
    await fanOut(event);
    await fanOut(event); // duplicate consumption: still one delivery
    expect((await deliver()).delivered).toBe(1);
    expect(received).toHaveLength(1);
    const r = received[0]!;
    expect(r.headers['x-uc-event-id']).toBe(event.eventId);
    expect(verify(secret, String(r.headers['x-uc-signature']), r.body)).toBe(true);
    expect(JSON.parse(r.body)).toMatchObject({
      id: event.eventId,
      type: 'OrderConfirmed',
      data: { orderId: event.payload.orderId },
    });
    // Rotation: the old secret no longer verifies new deliveries.
    const rotated = (await nw.post(`/v1/admin/webhooks/${endpoint.id}/rotate-secret`)).body as {
      secret: string;
    };
    await nw.post(`/v1/admin/webhooks/${endpoint.id}/test`).expect(202);
    await deliver();
    const ping = received.at(-1)!;
    expect(JSON.parse(ping.body).type).toBe('Ping');
    expect(verify(rotated.secret, String(ping.headers['x-uc-signature']), ping.body)).toBe(true);
    expect(verify(secret, String(ping.headers['x-uc-signature']), ping.body)).toBe(false);
    await nw.del(`/v1/admin/webhooks/${endpoint.id}`).expect(204);
  });

  it('retries a failing receiver with backoff, gives up after 8 attempts, and replays on request', async () => {
    const ep = (
      await nw
        .post('/v1/admin/webhooks')
        .send({ name: 'Flaky', url: receiverUrl, eventTypes: ['OrderConfirmed'] })
    ).body.endpoint;
    const { event } = await confirmedOrderEvent();
    await fanOut(event);
    receiverStatus = 503;
    let now = Date.now();
    const first = await deliver(new Date(now));
    expect(first.failed).toBeGreaterThanOrEqual(1);
    let d = await one<{ id: string; status: string; attempts: number; next: Date }>(
      'select id, status, attempts, next_attempt_at as next from webhook_deliveries where endpoint_id = $1',
      [ep.id],
    );
    expect(d).toMatchObject({ status: 'failed', attempts: 1 });
    expect(d.next.getTime()).toBeGreaterThan(now + 25_000); // backoff, not an immediate retry
    for (let i = 0; i < 7; i++) {
      now += 7 * 3600_000;
      await deliver(new Date(now));
    }
    d = await one('select id, status, attempts from webhook_deliveries where endpoint_id = $1', [ep.id]);
    expect(d).toMatchObject({ status: 'dead', attempts: 8 });
    const health = await nw.get('/v1/admin/operations/health');
    expect(health.body.checks.find((c: { key: string }) => c.key === 'webhooks_dead')).toMatchObject({
      status: expect.stringMatching(/warn|alert/),
    });
    receiverStatus = 200;
    await nw.post(`/v1/admin/webhook-deliveries/${d.id}/replay`).expect(200);
    expect((await deliver()).delivered).toBe(1);
    const page = await nw.get(`/v1/admin/webhooks/${ep.id}/deliveries`);
    expect(page.body.items[0]).toMatchObject({ status: 'delivered', attempts: 1 });
    expect((await nw.post(`/v1/admin/webhook-deliveries/${d.id}/replay`)).status).toBe(409);
    await nw.del(`/v1/admin/webhooks/${ep.id}`).expect(204);
  });

  it('refuses private and non-https targets when private targets are not allowed', async () => {
    for (const url of [
      'http://example.com/hook',
      'https://127.0.0.1/hook',
      'https://10.0.0.5/hook',
      'https://169.254.169.254/latest',
      'https://[::1]/x',
      'https://user:pw@example.com/',
    ])
      await expect(assertPublicUrl(url, false), url).rejects.toThrow();
    const strict = await startApp({ WEBHOOKS_ALLOW_PRIVATE_TARGETS: false });
    try {
      const s = scoped(await login(strict, 'owner@northwind.demo'), northwind);
      const r = await s
        .post('/v1/admin/webhooks')
        .send({ name: 'Internal', url: 'https://10.1.2.3/hook', eventTypes: ['OrderConfirmed'] });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('UNSAFE_URL');
    } finally {
      await strict.close();
    }
  });
});

describe('API keys (P-04)', () => {
  it('read within scope only, GET only, bound to the tenant; revoked/expired/ex-member keys stop working', async () => {
    const created = await nw
      .post('/v1/admin/api-keys')
      .send({ name: 'BI export', scopes: ['orders.read'], expiresInDays: 30 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const k = created.body.key as string;
    expect(JSON.stringify((await nw.get('/v1/admin/api-keys')).body)).not.toContain(k);
    const api = (path: string) => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${k}`);
    expect((await api('/v1/admin/orders')).status).toBe(200);
    expect((await api('/v1/admin/products')).status).toBe(403); // catalog.read not in scope
    expect(
      (
        await request(app.getHttpServer())
          .post('/v1/admin/orders')
          .set('Authorization', `Bearer ${k}`)
          .set(CSRF)
          .send({})
      ).status,
    ).toBe(403);
    const lumiere = await tenantId('lumiere-fine');
    expect((await api('/v1/admin/orders').set('x-tenant-id', lumiere)).status).toBe(403);
    expect(
      (await request(app.getHttpServer()).get('/v1/admin/orders').set('Authorization', 'Bearer uc_key_nope'))
        .status,
    ).toBe(401);
    // A key cannot carry permissions its creator lacks.
    const viewer = await createMember(northwind, ['viewer', 'admin']);
    const v = scoped(await login(app, viewer.email), northwind);
    const vk = (await v.post('/v1/admin/api-keys').send({ name: 'Admin key', scopes: ['catalog.read'] })).body
      .key as string;
    expect(
      (await request(app.getHttpServer()).get('/v1/admin/products').set('Authorization', `Bearer ${vk}`))
        .status,
    ).toBe(200);
    await ownerPool.query("update memberships set status = 'suspended' where id = $1", [viewer.membershipId]);
    expect(
      (await request(app.getHttpServer()).get('/v1/admin/products').set('Authorization', `Bearer ${vk}`))
        .status,
    ).toBe(403);
    // Expiry and revocation.
    await ownerPool.query("update api_keys set expires_at = now() - interval '1 minute' where id = $1", [
      created.body.apiKey.id,
    ]);
    expect((await api('/v1/admin/orders')).status).toBe(401);
    await ownerPool.query('update api_keys set expires_at = null where id = $1', [created.body.apiKey.id]);
    expect((await api('/v1/admin/orders')).status).toBe(200);
    await nw.post(`/v1/admin/api-keys/${created.body.apiKey.id}/revoke`).expect(200);
    expect((await api('/v1/admin/orders')).status).toBe(401);
    expect(
      (
        await one<{ last: Date | null }>('select last_used_at as last from api_keys where id = $1', [
          created.body.apiKey.id,
        ])
      ).last,
    ).not.toBeNull();
  });
});

describe('two-step verification (P-05)', () => {
  it('enrol, then sign-in needs a single-use code; recovery codes burn; merchants can require it for admins', async () => {
    const m = await createMember(northwind, ['admin']);
    const agent = await login(app, m.email);
    const enrol = await agent.post('/v1/auth/mfa/enroll').set(CSRF);
    expect(enrol.body.otpauthUri).toContain('otpauth://totp/');
    const secret = enrol.body.secret as string;
    expect((await agent.post('/v1/auth/mfa/confirm').set(CSRF).send({ code: '000000' })).status).toBe(422);
    const step = stepOf(Date.now());
    const confirmed = await agent
      .post('/v1/auth/mfa/confirm')
      .set(CSRF)
      .send({ code: totpAt(secret, step) });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const recovery = confirmed.body.recoveryCodes as string[];
    expect(recovery).toHaveLength(10);
    // Sign-in now stops at a challenge.
    const fresh = request.agent(app.getHttpServer());
    const first = await fresh
      .post('/v1/auth/login')
      .set(CSRF)
      .send({ email: m.email, password: TEST_PASSWORD, audience: 'merchant' });
    expect(first.status).toBe(401);
    expect(first.body.code).toBe('MFA_REQUIRED');
    expect(first.headers['set-cookie']).toBeUndefined();
    const challenge = first.body.details.challengeToken as string;
    expect(
      (
        await fresh
          .post('/v1/auth/mfa/verify')
          .set(CSRF)
          .send({ challengeToken: challenge, code: totpAt(secret, step) })
      ).status,
    ).toBe(401); // already used
    const ok = await fresh
      .post('/v1/auth/mfa/verify')
      .set(CSRF)
      .send({ challengeToken: challenge, code: totpAt(secret, step + 1) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await fresh.get('/v1/auth/me').query({ audience: 'merchant' })).body.user.email).toBe(m.email);
    expect(
      (
        await fresh
          .post('/v1/auth/mfa/verify')
          .set(CSRF)
          .send({ challengeToken: challenge, code: totpAt(secret, step + 1) })
      ).status,
    ).toBe(401); // challenge used
    // Recovery code: works once.
    const again = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set(CSRF)
      .send({ email: m.email, password: TEST_PASSWORD, audience: 'merchant' });
    expect(
      (
        await request(app.getHttpServer())
          .post('/v1/auth/mfa/verify')
          .set(CSRF)
          .send({ challengeToken: again.body.details.challengeToken, code: recovery[0] })
      ).status,
    ).toBe(200);
    const third = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set(CSRF)
      .send({ email: m.email, password: TEST_PASSWORD, audience: 'merchant' });
    expect(
      (
        await request(app.getHttpServer())
          .post('/v1/auth/mfa/verify')
          .set(CSRF)
          .send({ challengeToken: third.body.details.challengeToken, code: recovery[0] })
      ).status,
    ).toBe(401);
    expect((await agent.get('/v1/auth/mfa')).body).toMatchObject({ enrolled: true, recoveryCodesLeft: 9 });
    // Requirement: someone without MFA cannot turn it on; with it on, owners/admins without MFA are blocked.
    expect((await nw.put('/v1/admin/security').send({ requireMfaForAdmins: true })).body.code).toBe(
      'MFA_ENROLMENT_REQUIRED',
    );
    const admin = scoped(agent, northwind);
    await admin.put('/v1/admin/security').send({ requireMfaForAdmins: true }).expect(200);
    try {
      expect((await nw.get('/v1/admin/orders')).body.code).toBe('MFA_ENROLMENT_REQUIRED');
      expect((await admin.get('/v1/admin/orders')).status).toBe(200);
    } finally {
      await admin.put('/v1/admin/security').send({ requireMfaForAdmins: false }).expect(200);
    }
    expect((await nw.get('/v1/admin/orders')).status).toBe(200);
    // Turning it off needs the password and a code.
    expect(
      (await agent.post('/v1/auth/mfa/disable').set(CSRF).send({ password: 'wrong', code: recovery[1] }))
        .status,
    ).toBe(422);
    await agent
      .post('/v1/auth/mfa/disable')
      .set(CSRF)
      .send({ password: TEST_PASSWORD, code: recovery[1] })
      .expect(204);
    expect((await login(app, m.email)) !== undefined).toBe(true);
  });
});

describe('automations and staff inbox (P-06)', () => {
  it('runs matching rules once, skips non-matching ones, and actions never retrigger rules', async () => {
    const big = await nw.post('/v1/admin/automations').send({
      name: `Big orders ${uid()}`,
      trigger: 'OrderConfirmed',
      conditions: { minOrderTotalMinor: '1000' },
      action: { type: 'notify_staff', title: 'Large order confirmed' },
    });
    expect(big.status, JSON.stringify(big.body)).toBe(201);
    const huge = await nw.post('/v1/admin/automations').send({
      name: `Huge orders ${uid()}`,
      trigger: 'OrderConfirmed',
      conditions: { minOrderTotalMinor: '99999999' },
      action: { type: 'notify_staff', title: 'Huge order' },
    });
    try {
      const { event, orderId } = await confirmedOrderEvent();
      await fanOut(event);
      await fanOut(event);
      const runs = (await nw.get(`/v1/admin/automations/${big.body.id}/runs`)).body.items;
      expect(runs).toEqual([expect.objectContaining({ eventId: event.eventId, outcome: 'done' })]);
      expect((await nw.get(`/v1/admin/automations/${huge.body.id}/runs`)).body.items[0]).toMatchObject({
        outcome: 'skipped',
      });
      const inbox = (await nw.get('/v1/admin/notifications')).body;
      const n = inbox.items.find((i: { link: string | null }) => i.link === `/orders/${orderId}`);
      expect(n).toMatchObject({ title: 'Large order confirmed', read: false });
      const after = (await nw.post('/v1/admin/notifications/read').send({ ids: [n.id] })).body;
      expect(after.items.find((i: { id: string }) => i.id === n.id).read).toBe(true);
      // Notifications are not domain events: nothing new waits in the outbox for this rule.
      const loops = await one<{ n: number }>(
        "select count(*)::int as n from outbox_events where tenant_id = $1 and event_type = 'OrderConfirmed' and causation_id = $2",
        [northwind, event.eventId],
      );
      expect(loops.n).toBe(0);
    } finally {
      for (const a of [big.body, huge.body])
        await nw.put(`/v1/admin/automations/${a.id}`).send({
          name: a.name,
          trigger: a.trigger,
          conditions: a.conditions,
          action: a.action,
          status: 'paused',
          version: a.version,
        });
    }
  });
});

describe('operations health, dead events and export (P-07, P-08)', () => {
  it('reports real figures; operators replay dead events; read-only operators cannot', async () => {
    const health = await nw.get('/v1/admin/operations/health');
    expect(health.status).toBe(200);
    expect(health.body.checks.map((c: { key: string }) => c.key)).toEqual(
      expect.arrayContaining([
        'outbox_backlog',
        'outbox_dead',
        'webhooks_dead',
        'erp_export_lag',
        'connector_freshness',
        'reconciliation_aging',
        'stale_rates',
        'payment_failures',
      ]),
    );
    const id = randomUUID();
    await ownerPool.query(
      "insert into outbox_events (id, tenant_id, event_type, aggregate_type, aggregate_id, payload, status, attempts, last_error) values ($1::uuid, $2, 'OrderConfirmed', 'order', $1::text, '{}', 'dead', 10, 'broker unavailable')",
      [id, northwind],
    );
    expect(
      (await nw.get('/v1/admin/operations/health')).body.checks.find(
        (c: { key: string }) => c.key === 'outbox_dead',
      ).value,
    ).toBeGreaterThanOrEqual(1);
    const platform = await login(app, 'platform@uc.local', 'platform');
    expect(
      (await platform.get('/v1/platform/operations/dead-events')).body.items.some(
        (e: { id: string }) => e.id === id,
      ),
    ).toBe(true);
    const support = await login(app, 'support@uc.local', 'platform');
    expect((await support.post(`/v1/platform/operations/dead-events/${id}/replay`).set(CSRF)).status).toBe(
      403,
    );
    await platform.post(`/v1/platform/operations/dead-events/${id}/replay`).set(CSRF).expect(200);
    expect(
      (await one<{ status: string }>('select status from outbox_events where id = $1', [id])).status,
    ).toBe('pending');
    await ownerPool.query("update outbox_events set status = 'published' where id = $1", [id]);
    expect((await platform.get('/v1/platform/operations/health')).body.checks.length).toBeGreaterThan(0);
    expect(
      (await nw.get('/v1/admin/operations/providers')).body.items.find(
        (p: { key: string }) => p.key === 'sms',
      ),
    ).toMatchObject({ status: 'blocked' });
  });

  it('exports orders as CSV with the list filters', async () => {
    const csv = await nw.get('/v1/admin/orders-export.csv').query({ status: 'confirmed' });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const [header, ...rows] = csv.text.trim().split('\n');
    expect(header).toBe(
      'number,created_at,origin,status,payment_status,fulfillment_status,currency,subtotal_minor,discount_minor,tax_minor,total_minor,contact_name,contact_email',
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.split(',')[3] === 'confirmed')).toBe(true);
    const viewer = scoped(
      await login(app, (await createMember(northwind, ['fulfillment_operator'])).email),
      northwind,
    );
    expect((await viewer.get('/v1/admin/orders-export.csv')).status).toBe(200);
    const nobody = scoped(
      await login(app, (await createMember(northwind, ['catalog_editor'])).email),
      northwind,
    );
    expect((await nobody.get('/v1/admin/orders-export.csv')).status).toBe(403);
  });
});

describe('outage paths', () => {
  it('with Redis down, readiness reports it and sign-in still works (throttling fails open, DB lockout remains)', async () => {
    const degraded = await startApp({ REDIS_URL: 'redis://127.0.0.1:6399/1' });
    try {
      const ready = await request(degraded.getHttpServer()).get('/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body.checks.redis.status).toBe('down');
      expect(ready.body.checks.database.status).toBe('ok');
      const signIn = await request(degraded.getHttpServer())
        .post('/v1/auth/login')
        .set(CSRF)
        .send({ email: 'owner@northwind.demo', password: TEST_PASSWORD, audience: 'merchant' });
      expect(signIn.status).toBe(200);
    } finally {
      await degraded.close();
    }
  }, 60_000);
});
