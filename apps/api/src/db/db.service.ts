import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createDb, systemTx, tenantTx, type Db, type DbHandle, type Tx } from '@uc/db';
import { APP_CONFIG, type AppConfig } from '../config/config';

/**
 * Owns the runtime (uc_app) connection pool. All tenant data access goes through `tenant()`, which pins the
 * RLS context; `system()` is the reviewed escape hatch for platform/auth/storefront-resolver paths (ADR-002).
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly handle: DbHandle;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.handle = createDb(config.DATABASE_URL, { max: 20, appName: 'uc-api' });
  }

  get db(): Db {
    return this.handle.db;
  }

  tenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return tenantTx(this.handle.db, tenantId, fn);
  }

  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return systemTx(this.handle.db, fn);
  }

  async ping(): Promise<void> {
    await this.handle.pool.query('select 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.handle.close();
  }
}
