import { createDb } from '../client';
import { requireEnv } from '../env';
import { resetSchema, runMigrations } from '../migrate';
import { seedDemo } from '../seed';

async function main(): Promise<void> {
  const ownerUrl = requireEnv('DATABASE_OWNER_URL');
  await resetSchema(ownerUrl);
  await runMigrations(ownerUrl);
  console.log('Schema reset and migrations applied.');
  const handle = createDb(requireEnv('DATABASE_URL'), { appName: 'uc-seed' });
  try {
    const result = await seedDemo(handle.db, requireEnv('SEED_DEMO_PASSWORD'));
    console.table(result.tenantIds);
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error('Reset failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
