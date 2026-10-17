import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { IdempotencyService } from '../common/idempotency.service';
import { DbService } from './db.service';
import { RedisService } from './redis.service';

/** Global infrastructure: validated config, Postgres (RLS-aware), Redis, idempotency store. */
@Global()
@Module({})
export class CoreModule {
  static register(config: AppConfig): DynamicModule {
    const providers = [
      { provide: APP_CONFIG, useValue: config },
      DbService,
      RedisService,
      IdempotencyService,
    ];
    return { module: CoreModule, global: true, providers, exports: providers };
  }
}
