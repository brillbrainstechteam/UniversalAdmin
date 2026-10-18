import { execFileSync } from 'node:child_process';
import { cpSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { requireEnv } from '../src/env';
import { MIGRATIONS_FOLDER, runMigrations } from '../src/migrate';
import { CATALOG_RLS_TABLES } from '../src/catalog-schema';
import { RLS_TABLES as CORE_RLS_TABLES } from '../src/schema';

const RLS_TABLES = [...CORE_RLS_TABLES, ...CATALOG_RLS_TABLES];
const NON_TENANT_TABLES = [
  'idempotency_keys',
  'platform_admins',
  'processed_events',
  'sessions',
  'tenants',
  'users',
];
import { ownerPool } from './helpers';

const pool = ownerPool();
afterAll(() => pool.end());

describe('migrations (F-10)', () => {
  it('apply cleanly from an empty database (global setup) and create every table', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([...RLS_TABLES, ...NON_TENANT_TABLES].sort());
  });

  it('are idempotent: re-running applies nothing and keeps the journal unchanged', async () => {
    const before = await pool.query('select count(*)::int as n from drizzle.__drizzle_migrations');
    await runMigrations(requireEnv('TEST_DATABASE_OWNER_URL'));
    const after = await pool.query('select count(*)::int as n from drizzle.__drizzle_migrations');
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(after.rows[0].n).toBe(readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith('.sql')).length);
  });

  it('enable row-level security on every tenant-owned table', async () => {
    const { rows } = await pool.query<{ relname: string; relrowsecurity: boolean; policies: number }>(
      `select c.relname, c.relrowsecurity,
              (select count(*)::int from pg_policies p where p.tablename = c.relname) as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`,
    );
    for (const table of RLS_TABLES) {
      const row = rows.find((r) => r.relname === table);
      expect(row?.relrowsecurity, `${table} RLS`).toBe(true);
      expect(row?.policies, `${table} policy`).toBeGreaterThan(0);
    }
    // Every table with a tenant_id column must be protected.
    const { rows: tenantCols } = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.columns where table_schema='public' and column_name='tenant_id'`,
    );
    for (const { table_name } of tenantCols) expect(RLS_TABLES as readonly string[]).toContain(table_name);
  });

  it('runtime role is not the table owner and cannot bypass RLS', async () => {
    const { rows } = await pool.query(`select rolbypassrls, rolsuper from pg_roles where rolname = 'uc_app'`);
    expect(rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    const owners = await pool.query(`select distinct tableowner from pg_tables where schemaname = 'public'`);
    expect(owners.rows.map((r) => r.tableowner)).toEqual(['uc_owner']);
  });

  it('schema.ts and migrations have no drift', () => {
    // drizzle-kit resolves paths relative to cwd, so the probe lives inside the package (gitignored).
    const root = resolve(__dirname, '..');
    const dir = join(root, '.drift-probe');
    rmSync(dir, { recursive: true, force: true });
    try {
      cpSync(MIGRATIONS_FOLDER, join(dir, 'migrations'), { recursive: true });
      writeFileSync(
        join(dir, 'drizzle.config.ts'),
        `export default { dialect: 'postgresql', schema: ['./src/schema.ts', './src/catalog-schema.ts'], out: './.drift-probe/migrations' };`,
      );
      const output = execFileSync(
        process.execPath,
        [
          join(root, 'node_modules/drizzle-kit/bin.cjs'),
          'generate',
          '--config',
          join(dir, 'drizzle.config.ts'),
          '--name',
          'drift_probe',
        ],
        { cwd: root, encoding: 'utf8' },
      );
      expect(output).toMatch(/No schema changes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
