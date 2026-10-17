import { createDb } from '../client';
import { requireEnv } from '../env';
import { seedDemo } from '../seed';

async function main(): Promise<void> {
  const handle = createDb(requireEnv('DATABASE_URL'), { appName: 'uc-seed' });
  try {
    const result = await seedDemo(handle.db, requireEnv('SEED_DEMO_PASSWORD'));
    console.log('Demo data seeded (all tenants flagged is_demo):');
    console.table(result.tenantIds);
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
