import { createDb, requireEnv, resetSchema, runMigrations, seedDemo } from '@uc/db';
import Redis from 'ioredis';

export const E2E_PASSWORD = 'E2ePassword!2026';

/** Fresh migrated + seeded test database and empty Redis DB 3 for every E2E run. */
export default async function globalSetup(): Promise<void> {
  const ownerUrl = requireEnv('TEST_DATABASE_OWNER_URL');
  if (!/uc_test/.test(ownerUrl)) throw new Error('E2E must run against the uc_test database');
  await resetSchema(ownerUrl);
  await runMigrations(ownerUrl);
  const handle = createDb(requireEnv('TEST_DATABASE_URL'));
  try {
    await seedDemo(handle.db, E2E_PASSWORD);
  } finally {
    await handle.close();
  }
  const redis = new Redis(`${requireEnv('REDIS_URL').replace(/\/\d*$/, '')}/3`);
  await redis.flushdb();
  redis.disconnect();
}
