import { defineConfig, devices } from '@playwright/test';
import { requireEnv } from '@uc/db';

/**
 * E2E runs the real stack: built API (against the isolated uc_test database, Redis DB 3) and the Next.js admin
 * apps, the buyer portal and the B2C storefront in production mode. Locally uses the installed Chrome (no browser download); CI sets E2E_BROWSER_CHANNEL.
 */
const redisBase = requireEnv('REDIS_URL').replace(/\/\d*$/, '');
export const E2E_REDIS_URL = `${redisBase}/3`;
const channel = process.env.E2E_BROWSER_CHANNEL ?? 'chrome';

const apiEnv = {
  ...(process.env as Record<string, string>),
  NODE_ENV: 'test',
  DATABASE_URL: requireEnv('TEST_DATABASE_URL'),
  REDIS_URL: E2E_REDIS_URL,
  LOG_LEVEL: 'warn',
  S3_BUCKET: 'uc-e2e-media',
  S3_AUTO_CREATE_BUCKET: 'true',
  // The suite signs in many times from one IP; throttling itself is covered by API tests.
  LOGIN_RATE_LIMIT_PER_IP: '1000',
  LOGIN_RATE_LIMIT_PER_EMAIL: '1000',
  STOREFRONT_RATE_LIMIT_MULTIPLIER: '50',
};

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    channel: channel === 'chromium' ? undefined : channel,
  },
  webServer: [
    {
      command: 'node ../apps/api/dist/main.js',
      url: 'http://localhost:4100/health/ready',
      env: apiEnv,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @uc/merchant-admin start',
      url: 'http://localhost:3100/login',
      reuseExistingServer: false,
      timeout: 90_000,
    },
    {
      command: 'pnpm --filter @uc/platform-admin start',
      url: 'http://localhost:3101/login',
      reuseExistingServer: false,
      timeout: 90_000,
    },
    {
      // Buyer portal (Phase 08): its server-side proxy holds the storefront gateway key.
      command: 'pnpm --filter @uc/buyer-portal start',
      url: 'http://localhost:3102/login',
      env: {
        ...(process.env as Record<string, string>),
        STOREFRONT_GATEWAY_KEY: requireEnv('STOREFRONT_GATEWAY_KEY'),
      },
      reuseExistingServer: false,
      timeout: 90_000,
    },
    {
      // B2C storefront (Phase 09): same server-side gateway-key proxy.
      command: 'pnpm --filter @uc/storefront start',
      url: 'http://localhost:3103/account/login',
      env: {
        ...(process.env as Record<string, string>),
        STOREFRONT_GATEWAY_KEY: requireEnv('STOREFRONT_GATEWAY_KEY'),
      },
      reuseExistingServer: false,
      timeout: 90_000,
    },
  ],
});
