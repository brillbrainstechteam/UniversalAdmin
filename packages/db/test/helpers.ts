import { Pool } from 'pg';
import { createDb, type DbHandle } from '../src/client';
import { requireEnv } from '../src/env';

export const appDb = (): DbHandle =>
  createDb(requireEnv('TEST_DATABASE_URL'), { max: 5, appName: 'uc-db-test' });
export const ownerPool = (): Pool =>
  new Pool({ connectionString: requireEnv('TEST_DATABASE_OWNER_URL'), max: 2 });
