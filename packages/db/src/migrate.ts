import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolve } from 'node:path';
import { Pool } from 'pg';

export const MIGRATIONS_FOLDER = resolve(__dirname, '../migrations');

/** Apply all pending migrations. Must run as the schema owner role (uc_owner), never the runtime role. */
export async function runMigrations(ownerUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: ownerUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

/** Drop and recreate the application schemas (non-production only). Runs as the owner role. */
export async function resetSchema(ownerUrl: string): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to reset a production database');
  const pool = new Pool({ connectionString: ownerUrl, max: 1 });
  try {
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
  } finally {
    await pool.end();
  }
}
