import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditCount,
  createMember,
  CSRF,
  login,
  ownerPool,
  startApp,
  tenantId,
  TEST_PASSWORD,
} from '../helpers';

let app: INestApplication;
let aurum: string;
beforeAll(async () => {
  app = await startApp();
  aurum = await tenantId('aurum-wholesale');
});
afterAll(() => app.close());

const post = (path: string) => request(app.getHttpServer()).post(path).set(CSRF);

describe('login (F-05)', () => {
  it('sets an HttpOnly, SameSite=Strict, audience-specific session cookie and returns memberships', async () => {
    const res = await post('/v1/auth/login').send({
      email: 'OWNER@aurum.demo',
      password: TEST_PASSWORD,
      audience: 'merchant',
    });
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^uc_m_sess=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(res.body.user.email).toBe('owner@aurum.demo');
    expect(res.body.memberships.map((m: { tenantSlug: string }) => m.tenantSlug)).toEqual([
      'aurum-wholesale',
    ]);
    expect(res.body.memberships[0].roles[0].key).toBe('owner');
    expect(res.body).not.toHaveProperty('user.passwordHash');
  });

  it('multi-tenant users see every membership but nothing else', async () => {
    const agent = await login(app, 'multi@demo.local');
    const me = await agent.get('/v1/auth/me').query({ audience: 'merchant' });
    expect(me.body.memberships.map((m: { tenantSlug: string }) => m.tenantSlug).sort()).toEqual([
      'aurum-wholesale',
      'northwind-general',
    ]);
  });

  it('rejects wrong password and unknown email with the same error (no enumeration)', async () => {
    const wrong = await post('/v1/auth/login').send({
      email: 'owner@aurum.demo',
      password: 'nope-nope-nope',
      audience: 'merchant',
    });
    const unknown = await post('/v1/auth/login').send({
      email: 'ghost@aurum.demo',
      password: 'nope-nope-nope',
      audience: 'merchant',
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.message).toBe(wrong.body.message);
    expect(wrong.body.correlationId).toBeTruthy();
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('records failed sign-ins in the audit log', async () => {
    const before = await auditCount(null, 'auth.login_failed');
    await post('/v1/auth/login').send({
      email: 'viewer@aurum.demo',
      password: 'wrong-password!!',
      audience: 'merchant',
    });
    expect(await auditCount(null, 'auth.login_failed')).toBe(before + 1);
  });

  it('locks an account after 5 consecutive failures, even for the right password', async () => {
    const { email } = await createMember(aurum, ['viewer']);
    for (let i = 0; i < 5; i++) {
      const r = await post('/v1/auth/login').send({
        email,
        password: 'wrong-password!!',
        audience: 'merchant',
      });
      expect(r.status).toBe(401);
    }
    const locked = await post('/v1/auth/login').send({
      email,
      password: TEST_PASSWORD,
      audience: 'merchant',
    });
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
    expect(await auditCount(null, 'auth.account_locked')).toBeGreaterThan(0);
  });

  it('rejects mutations without the CSRF header and from foreign origins', async () => {
    const noHeader = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: 'owner@aurum.demo', password: TEST_PASSWORD, audience: 'merchant' });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.code).toBe('CSRF_CHECK_FAILED');
    const evil = await post('/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'owner@aurum.demo', password: TEST_PASSWORD, audience: 'merchant' });
    expect(evil.status).toBe(403);
    const allowed = await post('/v1/auth/login')
      .set('Origin', 'http://localhost:3100')
      .send({ email: 'owner@aurum.demo', password: TEST_PASSWORD, audience: 'merchant' });
    expect(allowed.status).toBe(200);
  });

  it('validates the body with the shared schema', async () => {
    const res = await post('/v1/auth/login').send({ email: 'not-an-email', password: '', audience: 'admin' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.details.map((d: { path: string }) => d.path).sort()).toEqual([
      'audience',
      'email',
      'password',
    ]);
  });
});

describe('sessions', () => {
  it('logout revokes the session server-side', async () => {
    const loginRes = await post('/v1/auth/login').send({
      email: 'owner@lumiere.demo',
      password: TEST_PASSWORD,
      audience: 'merchant',
    });
    const cookie = String(loginRes.headers['set-cookie']).split(';')[0]!;
    const me = () =>
      request(app.getHttpServer()).get('/v1/auth/me').query({ audience: 'merchant' }).set('Cookie', cookie);
    expect((await me()).status).toBe(200);
    const out = await post('/v1/auth/logout').query({ audience: 'merchant' }).set('Cookie', cookie);
    expect(out.status).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/uc_m_sess=;/);
    // Replaying the old cookie value no longer works: revocation is server-side.
    expect((await me()).status).toBe(401);
  });

  it('logout-all revokes every session of the user', async () => {
    const { email } = await createMember(aurum, ['viewer']);
    const a = await login(app, email);
    const b = await login(app, email);
    expect((await a.post('/v1/auth/logout-all').set(CSRF).query({ audience: 'merchant' })).status).toBe(204);
    expect((await b.get('/v1/auth/me').query({ audience: 'merchant' })).status).toBe(401);
  });

  it('expired sessions are rejected', async () => {
    const { email, userId } = await createMember(aurum, ['viewer']);
    const agent = await login(app, email);
    await ownerPool.query(`update sessions set expires_at = now() - interval '1 second' where user_id = $1`, [
      userId,
    ]);
    expect((await agent.get('/v1/auth/me').query({ audience: 'merchant' })).status).toBe(401);
  });

  it('idle sessions are revoked', async () => {
    const { email, userId } = await createMember(aurum, ['viewer']);
    const agent = await login(app, email);
    await ownerPool.query(
      `update sessions set last_seen_at = now() - interval '3 hours' where user_id = $1`,
      [userId],
    );
    expect((await agent.get('/v1/auth/me').query({ audience: 'merchant' })).status).toBe(401);
    const { rows } = await ownerPool.query('select revoked_at from sessions where user_id = $1', [userId]);
    expect(rows[0].revoked_at).not.toBeNull();
  });

  it('suspended (disabled) users cannot use existing sessions', async () => {
    const { email, userId } = await createMember(aurum, ['viewer']);
    const agent = await login(app, email);
    await ownerPool.query(`update users set status = 'disabled' where id = $1`, [userId]);
    expect((await agent.get('/v1/auth/me').query({ audience: 'merchant' })).status).toBe(401);
  });
});

describe('audience separation', () => {
  it('merchant users cannot obtain a platform session', async () => {
    const res = await post('/v1/auth/login').send({
      email: 'owner@aurum.demo',
      password: TEST_PASSWORD,
      audience: 'platform',
    });
    expect(res.status).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('a merchant session cannot call platform APIs, and a platform session cannot call merchant APIs', async () => {
    const merchant = await login(app, 'owner@aurum.demo');
    expect((await merchant.get('/v1/platform/tenants')).status).toBe(401);
    const platform = await login(app, 'platform@uc.local', 'platform');
    const res = await platform.get('/v1/admin/context').set('x-tenant-id', aurum);
    expect(res.status).toBe(401);
  });

  it('platform operators have no implicit merchant membership', async () => {
    const both = await login(app, 'platform@uc.local', 'merchant');
    const me = await both.get('/v1/auth/me').query({ audience: 'merchant' });
    expect(me.body.memberships).toEqual([]);
    expect((await both.get('/v1/admin/context').set('x-tenant-id', aurum)).body.code).toBe(
      'TENANT_ACCESS_DENIED',
    );
  });
});

describe('rate limiting', () => {
  it('throttles login attempts per IP', async () => {
    const limited = await startApp({ loginRateLimit: { perIp: 3, perEmail: 100, windowSeconds: 60 } });
    try {
      const server = limited.getHttpServer();
      // Distinct IP bucket for this test via X-Forwarded-For from the trusted loopback proxy.
      const attempt = () =>
        request(server)
          .post('/v1/auth/login')
          .set(CSRF)
          .set('X-Forwarded-For', '203.0.113.77')
          .send({ email: 'x@y.test', password: 'whatever-123', audience: 'merchant' });
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await attempt()).status);
      expect(statuses).toEqual([401, 401, 401, 429]);
    } finally {
      await limited.close();
    }
  });
});
