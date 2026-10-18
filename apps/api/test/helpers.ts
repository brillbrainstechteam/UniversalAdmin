import type { INestApplication } from '@nestjs/common';
import { hashPassword, requireEnv } from '@uc/db';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../src/bootstrap';
import { loadConfig, type AppConfig } from '../src/config/config';
import { TEST_PASSWORD, TEST_REDIS_URL } from './env';

export { TEST_PASSWORD };
export const CSRF = { 'x-uc-csrf': '1' } as const;

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return loadConfig(
    {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: requireEnv('TEST_DATABASE_URL'),
      REDIS_URL: TEST_REDIS_URL,
      LOG_LEVEL: 'silent',
      MERCHANT_ADMIN_URL: 'http://localhost:3100',
      S3_BUCKET: 'uc-test-media',
      S3_AUTO_CREATE_BUCKET: 'true',
    },
    { loginRateLimit: { perIp: 100_000, perEmail: 100_000, windowSeconds: 600 }, ...overrides },
  );
}

export async function startApp(overrides: Partial<AppConfig> = {}): Promise<INestApplication> {
  const app = await createApp(testConfig(overrides));
  await app.init();
  return app;
}

export type Agent = ReturnType<typeof request.agent>;

/** Logs in and returns a cookie-carrying agent. */
export async function login(
  app: INestApplication,
  email: string,
  audience: 'merchant' | 'platform' = 'merchant',
  password = TEST_PASSWORD,
): Promise<Agent> {
  const agent = request.agent(app.getHttpServer());
  const res = await agent.post('/v1/auth/login').set(CSRF).send({ email, password, audience });
  if (res.status !== 200) throw new Error(`login ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

/** Direct owner-role access for fixtures and assertions (bypasses RLS; test-only). */
export const ownerPool = new Pool({ connectionString: requireEnv('TEST_DATABASE_OWNER_URL'), max: 3 });

export async function tenantId(slug: string): Promise<string> {
  const { rows } = await ownerPool.query('select id from tenants where slug = $1', [slug]);
  if (!rows[0]) throw new Error(`no tenant ${slug}`);
  return rows[0].id as string;
}

export async function locationId(slug: string, code: string): Promise<string> {
  const { rows } = await ownerPool.query(
    'select l.id from locations l join tenants t on t.id = l.tenant_id where t.slug = $1 and l.code = $2',
    [slug, code],
  );
  return rows[0].id as string;
}

export async function roleId(tenant: string, key: string): Promise<string> {
  const { rows } = await ownerPool.query('select id from roles where tenant_id = $1 and key = $2', [
    tenant,
    key,
  ]);
  return rows[0].id as string;
}

let counter = 0;
export const uniqueEmail = (prefix: string) => `${prefix}-${Date.now()}-${++counter}@test.local`;

/** Creates a user with a membership holding the given system roles. */
export async function createMember(
  tenant: string,
  roleKeys: string[],
  options: { email?: string; locationScope?: string[] | null; password?: string } = {},
): Promise<{ userId: string; membershipId: string; email: string }> {
  const email = options.email ?? uniqueEmail(roleKeys.join('-'));
  const passwordHash = await hashPassword(options.password ?? TEST_PASSWORD);
  const user = await ownerPool.query(
    'insert into users (email, display_name, password_hash) values ($1, $2, $3) returning id',
    [email, `Test ${roleKeys.join('+')}`, passwordHash],
  );
  const member = await ownerPool.query(
    'insert into memberships (tenant_id, user_id, location_scope) values ($1, $2, $3) returning id',
    [tenant, user.rows[0].id, options.locationScope ?? null],
  );
  for (const key of roleKeys) {
    await ownerPool.query(
      'insert into membership_roles (tenant_id, membership_id, role_id) values ($1, $2, $3)',
      [tenant, member.rows[0].id, await roleId(tenant, key)],
    );
  }
  return { userId: user.rows[0].id as string, membershipId: member.rows[0].id as string, email };
}

export async function auditCount(tenant: string | null, action: string): Promise<number> {
  const { rows } = await ownerPool.query(
    `select count(*)::int as n from audit_events where action = $1 and ${tenant ? 'tenant_id = $2' : 'tenant_id is null'}`,
    tenant ? [action, tenant] : [action],
  );
  return rows[0].n as number;
}
