import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Load the repository-root .env once (src/ and dist/ are both two levels below packages/db).
const rootEnv = resolve(__dirname, '../../../.env');
if (existsSync(rootEnv)) config({ path: rootEnv, quiet: true } as Parameters<typeof config>[0]);

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}
