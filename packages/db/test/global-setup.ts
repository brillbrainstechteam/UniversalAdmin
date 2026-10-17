import { requireEnv } from '../src/env';
import { resetSchema, runMigrations } from '../src/migrate';

/** Every run starts from an empty test database and applies all migrations (F-10). */
export default async function setup(): Promise<void> {
  const ownerUrl = requireEnv('TEST_DATABASE_OWNER_URL');
  if (!/uc_test/.test(ownerUrl))
    throw new Error('TEST_DATABASE_OWNER_URL must point at the uc_test database');
  await resetSchema(ownerUrl);
  await runMigrations(ownerUrl);
}
