import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/config';

/** Redis is used for throttling/caching only — never as the sole source of truth (specs/01). */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    // Offline queue on: commands issued during (re)connect wait instead of failing (and failing open).
    this.client = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, connectTimeout: 3_000 });
    // Connection errors surface through readiness checks; avoid unhandled 'error' events.
    this.client.on('error', () => undefined);
  }

  /**
   * Fixed-window counter. Returns false when `limit` is exceeded within `windowSeconds`.
   * Fails open only if Redis is unreachable AND `failOpen` is set; login throttling also has DB lockout.
   */
  async hit(key: string, limit: number, windowSeconds: number, failOpen = true): Promise<boolean> {
    try {
      const count = await this.client.incr(key);
      if (count === 1) await this.client.expire(key, windowSeconds);
      return count <= limit;
    } catch {
      return failOpen;
    }
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }
}
