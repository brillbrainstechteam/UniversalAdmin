import { hash, verify } from '@node-rs/argon2';
import { createHash, randomBytes } from 'node:crypto';

// argon2id parameters (OWASP 2024 baseline: m=19MiB, t=2, p=1).
const ARGON_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** 256-bit random token, base64url. Only its SHA-256 hash is persisted. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
