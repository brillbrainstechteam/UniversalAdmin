import { createDb, requireEnv, resetSchema, runMigrations, seedDemo } from '@uc/db';
import Redis from 'ioredis';
import { TEST_PASSWORD, TEST_REDIS_URL } from './env';

/** Clean database + migrations + demo seed, and an empty Redis test DB, once per test run. */
export default async function setup(): Promise<void> {
  const ownerUrl = requireEnv('TEST_DATABASE_OWNER_URL');
  if (!/uc_test/.test(ownerUrl)) throw new Error('TEST_DATABASE_OWNER_URL must point at uc_test');
  await resetSchema(ownerUrl);
  await runMigrations(ownerUrl);
  const handle = createDb(requireEnv('TEST_DATABASE_URL'));
  try {
    await seedDemo(handle.db, TEST_PASSWORD);
  } finally {
    await handle.close();
  }
  const redis = new Redis(TEST_REDIS_URL);
  await redis.flushdb();
  redis.disconnect();
}
