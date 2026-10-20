import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Secrets the platform itself must use (webhook signing keys, TOTP seeds) are stored encrypted with AES-256-GCM
 * (Phase 11, ADR-026). Format: `v1:<iv b64url>:<tag b64url>:<ciphertext b64url>`. The key comes from
 * SECRETS_ENCRYPTION_KEY (any string; SHA-256-derived to 32 bytes). Connector credentials remain secret-store
 * references and are never stored here.
 */
function keyOf(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function encryptSecret(plain: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(key), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    data.toString('base64url'),
  ].join(':');
}

export function decryptSecret(sealed: string, key: string): string {
  const [v, iv, tag, data] = sealed.split(':');
  if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unknown secret format');
  const decipher = createDecipheriv('aes-256-gcm', keyOf(key), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
