import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, types } from 'pg';
import * as catalogSchema from './catalog-schema';
import * as jewellerySchema from './jewellery-schema';
import * as coreSchema from './schema';

const schema = { ...coreSchema, ...catalogSchema, ...jewellerySchema };

// NUMERIC (1700) and INT8 (20) stay strings: never coerce money/weights to JS floats.
types.setTypeParser(1700, (v) => v);
types.setTypeParser(20, (v) => v);

export type Schema = typeof coreSchema & typeof catalogSchema & typeof jewellerySchema;
export type Db = NodePgDatabase<Schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything that can run queries: the pool-backed db or an open transaction. */
export type Executor = Db | Tx;

export interface DbHandle {
  db: Db;
  pool: Pool;
  close(): Promise<void>;
}

export function createDb(
  connectionString: string,
  options: { max?: number; appName?: string } = {},
): DbHandle {
  const pool = new Pool({
    connectionString,
    max: options.max ?? 10,
    application_name: options.appName ?? 'uc',
    idleTimeoutMillis: 30_000,
  });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` in a transaction whose RLS context is pinned to `tenantId` (ADR-002).
 * Rows of other tenants are invisible even if a query forgets its tenant filter.
 */
export async function tenantTx<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new Error('tenantTx requires a UUID tenant id');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/**
 * Cross-tenant/system transaction (platform operations, auth lookups, workers, storefront resolver).
 * Usage is deliberately explicit so reviews can find every call site.
 */
export async function systemTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
    return fn(tx);
  });
}
