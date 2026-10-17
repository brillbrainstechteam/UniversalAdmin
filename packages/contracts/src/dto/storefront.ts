import { ChannelTypeSchema, ThemeTokens } from './admin';
import { z } from '../z';

export const StorefrontConfig = z
  .object({
    tenant: z.object({ slug: z.string(), displayName: z.string(), isDemo: z.boolean() }),
    channel: z.object({ code: z.string(), name: z.string(), type: ChannelTypeSchema }),
    hostname: z.string(),
    theme: ThemeTokens,
    currency: z.string(),
    locale: z.string(),
    timezone: z.string(),
  })
  .openapi('StorefrontConfig');
export type StorefrontConfig = z.infer<typeof StorefrontConfig>;

export const HealthResponse = z
  .object({
    status: z.enum(['ok', 'degraded']),
    checks: z.record(z.object({ status: z.enum(['ok', 'down']), latencyMs: z.number().optional(), error: z.string().optional() })),
    time: z.string(),
  })
  .openapi('HealthResponse');
export type HealthResponse = z.infer<typeof HealthResponse>;
