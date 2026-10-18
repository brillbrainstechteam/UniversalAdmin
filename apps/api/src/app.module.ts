import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { AppConfig } from './config/config';
import { CoreModule } from './db/db.module';
import { AccessService } from './modules/access/access.service';
import {
  CsrfGuard,
  MerchantSessionGuard,
  PermissionGuard,
  PlatformGuard,
  PlatformSessionGuard,
  TenantGuard,
} from './modules/access/guards';
import { AuditQueryService } from './modules/audit/audit-query.service';
import { StorageService } from './common/storage.service';
import { CatalogController } from './modules/catalog/catalog.controller';
import { JewelleryController } from './modules/jewellery/jewellery.controller';
import { JewelleryService } from './modules/jewellery/jewellery.service';
import { SerialItemsService } from './modules/jewellery/serial-items.service';
import { CatalogService } from './modules/catalog/catalog.service';
import { ImportService } from './modules/catalog/import.service';
import { SavedViewsService } from './modules/catalog/saved-views.service';
import { TaxonomyController } from './modules/catalog/taxonomy.controller';
import { TaxonomyService } from './modules/catalog/taxonomy.service';
import {
  StorefrontCatalogController,
  StorefrontCatalogService,
} from './modules/storefront/storefront-catalog.controller';
import { AuthController } from './modules/auth/auth.controller';
import { AuthService } from './modules/auth/auth.service';
import { SessionService } from './modules/auth/session.service';
import { LocationController } from './modules/location/location.controller';
import { LocationService } from './modules/location/location.service';
import { PlatformController } from './modules/platform/platform.controller';
import { PlatformTenantsService } from './modules/platform/platform-tenants.service';
import { StaffController } from './modules/staff/staff.controller';
import { StaffService } from './modules/staff/staff.service';
import { StoreController } from './modules/store/store.controller';
import { StoreService } from './modules/store/store.service';
import { StorefrontController, StorefrontResolver } from './modules/storefront/storefront.controller';
import { SystemController } from './modules/system/system.controller';
import { TenantAdminController } from './modules/tenant/tenant-admin.controller';
import { TenantAdminService } from './modules/tenant/tenant-admin.service';

/**
 * Modular monolith root (ADR-004). Phase 01 modules: identity/auth, access (RBAC + tenant resolution), tenant admin,
 * stores/channels, locations, staff/roles, audit, platform tenants, storefront resolver, system.
 */
@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [CoreModule.register(config)],
      controllers: [
        SystemController,
        AuthController,
        TenantAdminController,
        StoreController,
        LocationController,
        StaffController,
        PlatformController,
        StorefrontController,
        CatalogController,
        TaxonomyController,
        StorefrontCatalogController,
        JewelleryController,
      ],
      providers: [
        { provide: APP_GUARD, useClass: CsrfGuard },
        SessionService,
        AuthService,
        AccessService,
        MerchantSessionGuard,
        PlatformSessionGuard,
        TenantGuard,
        PermissionGuard,
        PlatformGuard,
        AuditQueryService,
        TenantAdminService,
        StoreService,
        LocationService,
        StaffService,
        PlatformTenantsService,
        StorefrontResolver,
        StorageService,
        CatalogService,
        TaxonomyService,
        SavedViewsService,
        ImportService,
        StorefrontCatalogService,
        JewelleryService,
        SerialItemsService,
      ],
    };
  }
}
