import { describe, expect, it } from 'vitest';
import { webhookSettings } from '../src/ops-jobs';

describe('webhook worker settings (Phase 11)', () => {
  it('refuses the development key and private targets in production', () => {
    expect(webhookSettings({ NODE_ENV: 'development' })).toMatchObject({ allowPrivate: false });
    expect(() => webhookSettings({ NODE_ENV: 'production' })).toThrow(/SECRETS_ENCRYPTION_KEY/);
    const key = 'a-private-secrets-key-for-production-000000001';
    expect(() =>
      webhookSettings({
        NODE_ENV: 'production',
        SECRETS_ENCRYPTION_KEY: key,
        WEBHOOKS_ALLOW_PRIVATE_TARGETS: 'true',
      }),
    ).toThrow(/WEBHOOKS_ALLOW_PRIVATE_TARGETS/);
    expect(webhookSettings({ NODE_ENV: 'production', SECRETS_ENCRYPTION_KEY: key })).toEqual({
      secretsKey: key,
      allowPrivate: false,
    });
  });
});
