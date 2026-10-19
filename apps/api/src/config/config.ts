import { requireEnv } from '@uc/db';
import { z } from '@uc/contracts';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  API_PORT: z.coerce.number().int().positive().default(4100),
  API_PUBLIC_URL: z.string().url(),
  ALLOWED_ORIGINS: z.string().transform((s) =>
    s
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  ),
  MERCHANT_ADMIN_URL: z.string().url(),
  STOREFRONT_GATEWAY_KEY: z.string().min(32, 'STOREFRONT_GATEWAY_KEY must be at least 32 characters'),
  COOKIE_SECURE: bool.default('false'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Phase 02 media storage (S3-compatible; SeaweedFS in dev, ADR-012).
  S3_ENDPOINT: z.string().url().default('http://localhost:9010'),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(3).default('uc-dev-media'),
  S3_ACCESS_KEY_ID: z.string().default('uc_s3_dev'),
  S3_SECRET_ACCESS_KEY: z.string().default('uc_s3_dev_secret'),
  S3_AUTO_CREATE_BUCKET: bool.default('false'),
  // Sign-in throttling per 10-minute window (DB lockout still applies). Raise only for automated test runs.
  LOGIN_RATE_LIMIT_PER_IP: z.coerce.number().int().min(1).default(30),
  LOGIN_RATE_LIMIT_PER_EMAIL: z.coerce.number().int().min(1).default(15),
  // Phase 07 sandbox payment gateway (test double, never real money). Refused in production.
  PAYMENTS_SANDBOX_ENABLED: bool.default('true'),
  PAYMENTS_SANDBOX_SECRET: z
    .string()
    .min(32, 'PAYMENTS_SANDBOX_SECRET must be at least 32 characters')
    .default('dev-only-sandbox-payment-signing-secret-0123456789'),
});

export type AppConfig = z.infer<typeof ConfigSchema> & {
  session: { merchantTtlMs: number; platformTtlMs: number; idleTimeoutMs: number };
  lockout: { maxFailures: number; lockMs: number };
  loginRateLimit: { perIp: number; perEmail: number; windowSeconds: number };
  invitationTtlMs: number;
};

export const APP_CONFIG = Symbol('APP_CONFIG');

/** Validates the environment once at boot; the process fails fast on misconfiguration. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<AppConfig> = {},
): AppConfig {
  requireEnv('DATABASE_URL'); // also triggers root .env loading via @uc/db
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE must be true in production');
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.PAYMENTS_SANDBOX_ENABLED) {
    throw new Error(
      'PAYMENTS_SANDBOX_ENABLED must be false in production (the sandbox gateway takes no real payments)',
    );
  }
  return {
    ...parsed.data,
    session: { merchantTtlMs: 12 * 3600_000, platformTtlMs: 8 * 3600_000, idleTimeoutMs: 2 * 3600_000 },
    lockout: { maxFailures: 5, lockMs: 15 * 60_000 },
    loginRateLimit: {
      perIp: parsed.data.LOGIN_RATE_LIMIT_PER_IP,
      perEmail: parsed.data.LOGIN_RATE_LIMIT_PER_EMAIL,
      windowSeconds: 600,
    },
    invitationTtlMs: 7 * 24 * 3600_000,
    ...overrides,
  };
}
