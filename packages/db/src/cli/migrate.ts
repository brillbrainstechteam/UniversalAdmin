import { requireEnv } from '../env';
import { runMigrations } from '../migrate';

runMigrations(requireEnv('DATABASE_OWNER_URL'))
  .then(() => console.log('Migrations applied.'))
  .catch((error: unknown) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
