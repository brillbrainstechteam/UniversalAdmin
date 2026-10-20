import { describe, expect, it } from 'vitest';
import { monthStartIn } from '../../src/modules/launch/plans.service';
import { decodeCursor, encodeCursor, paginate } from '../../src/common/cursor';
import { AppError } from '../../src/common/errors';
import { likePattern } from '../../src/common/mappers';
import { loadConfig } from '../../src/config/config';

describe('cursor pagination', () => {
  it('round-trips sort value and id', () => {
    const id = '0b0f6d8e-6a4c-4b8e-9d55-5d2a3d5a1f00';
    expect(decodeCursor(encodeCursor('2026-10-17T10:00:00.000Z', id))).toEqual({
      sortValue: '2026-10-17T10:00:00.000Z',
      id,
    });
  });
  it('rejects malformed or injected cursors', () => {
    expect(() => decodeCursor('garbage')).toThrow(AppError);
    expect(() => decodeCursor(Buffer.from(JSON.stringify(['x', "1' or 1=1"])).toString('base64url'))).toThrow(
      AppError,
    );
  });
  it('emits a next cursor only when more rows exist', () => {
    const rows = [1, 2, 3].map((n) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, n }));
    expect(paginate(rows, 3, (r) => r.n).nextCursor).toBeNull();
    const page = paginate(rows, 2, (r) => r.n);
    expect(page.items).toHaveLength(2);
    expect(decodeCursor(page.nextCursor!)).toEqual({ sortValue: 2, id: rows[1]!.id });
  });
});

describe('search input', () => {
  it('escapes LIKE wildcards', () => {
    expect(likePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });
});

describe('configuration', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5440/db',
    REDIS_URL: 'redis://localhost:6390',
    API_PUBLIC_URL: 'http://localhost:4100',
    ALLOWED_ORIGINS: 'http://localhost:3100, http://localhost:3101',
    MERCHANT_ADMIN_URL: 'http://localhost:3100',
    STOREFRONT_GATEWAY_KEY: 'k'.repeat(40),
  };
  it('parses origins and defaults', () => {
    const c = loadConfig(base);
    expect(c.ALLOWED_ORIGINS).toEqual(['http://localhost:3100', 'http://localhost:3101']);
    expect(c.COOKIE_SECURE).toBe(false);
  });
  it('fails fast on weak secrets and insecure production cookies', () => {
    expect(() => loadConfig({ ...base, STOREFRONT_GATEWAY_KEY: 'short' })).toThrow(/STOREFRONT_GATEWAY_KEY/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/COOKIE_SECURE/);
    // The sandbox payment gateway can never run in production (ADR-022).
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'true' })).toThrow(
      /PAYMENTS_SANDBOX_ENABLED/,
    );
    // Secrets at rest and preview links must not use the published development keys (ADR-025, ADR-026).
    const prod = {
      ...base,
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      PAYMENTS_SANDBOX_ENABLED: 'false',
    };
    expect(() => loadConfig(prod)).toThrow(/SECRETS_ENCRYPTION_KEY/);
    const keyed = { ...prod, SECRETS_ENCRYPTION_KEY: 'a-private-secrets-key-for-production-000000001' };
    expect(() => loadConfig({ ...keyed, WEBHOOKS_ALLOW_PRIVATE_TARGETS: 'true' })).toThrow(
      /WEBHOOKS_ALLOW_PRIVATE_TARGETS/,
    );
    expect(() => loadConfig({ ...keyed, STOREFRONT_RATE_LIMIT_MULTIPLIER: '50' })).toThrow(
      /STOREFRONT_RATE_LIMIT_MULTIPLIER/,
    );
    expect(() => loadConfig(keyed)).toThrow(/PREVIEW_TOKEN_SECRET/);
    expect(
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        PAYMENTS_SANDBOX_ENABLED: 'false',
        PREVIEW_TOKEN_SECRET: 'a-private-preview-secret-for-production-0001',
        SECRETS_ENCRYPTION_KEY: 'a-private-secrets-key-for-production-000000001',
      }).PAYMENTS_SANDBOX_ENABLED,
    ).toBe(false);
    expect(() => loadConfig({ ...base, PAYMENTS_SANDBOX_SECRET: 'short' })).toThrow(
      /PAYMENTS_SANDBOX_SECRET/,
    );
  });
});

describe('plan usage month window (Phase 12)', () => {
  it('starts at local midnight on the 1st in the merchant time zone', () => {
    const now = new Date('2026-10-20T10:00:00Z');
    expect(monthStartIn('Asia/Kolkata', now).toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(monthStartIn('UTC', now).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(monthStartIn('America/New_York', now).toISOString()).toBe('2026-10-01T04:00:00.000Z');
    // Just after local midnight on the 1st already belongs to the new month.
    expect(monthStartIn('Asia/Kolkata', new Date('2026-10-31T18:31:00Z')).toISOString()).toBe(
      '2026-10-31T18:30:00.000Z',
    );
  });
});
