import { requireEnv } from '@uc/db';

export const TEST_PASSWORD = 'TestPassword!2026';
/** Redis logical DB 1 keeps test keys away from the dev database (DB 0). */
export const TEST_REDIS_URL = `${requireEnv('REDIS_URL').replace(/\/\d*$/, '')}/1`;
