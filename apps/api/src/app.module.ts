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
import { InventoryController } from './modules/inventory/inventory.controller';
import { ConnectionsService } from './modules/integrations/connections.service';
import { IntegrationsController } from './modules/integrations/integrations.controller';
import { SyncService } from './modules/integrations/sync.service';
import { InventoryQueryService } from './modules/inventory/inventory-query.service';
import { InventoryService } from './modules/inventory/inventory.service';
import { JewelleryService } from './modules/jewellery/jewellery.service';
import { PricingController, StorefrontPricingController } from './modules/pricing/pricing.controller';
import { PricingService } from './modules/pricing/pricing.service';
import { BuyerController, CompaniesController } from './modules/b2b/b2b.controller';
import { AccountService } from './modules/customers/account.service';
import { CustomerAuthService } from './modules/customers/customer-auth.service';
import { CustomersController, StorefrontAccountController } from './modules/customers/customers.controller';
import { CustomersService } from './modules/customers/customers.service';
import { FulfillmentController } from './modules/fulfillment/fulfillment.controller';
import { DiscountsService } from './modules/discounts/discounts.service';
import { PromotionsService } from './modules/discounts/promotions.service';
import { MarketingService } from './modules/marketing/marketing.service';
import {
  DiscountsController,
  MarketingController,
  OnlineStoreController,
  ReportsController,
  StorefrontContentController,
} from './modules/online-store/growth.controller';
import { OnlineStoreService } from './modules/online-store/online-store.service';
import { ReportsService } from './modules/reports/reports.service';
import { FulfillmentService } from './modules/fulfillment/fulfillment.service';
import { RefundsService } from './modules/fulfillment/refunds.service';
import { ReturnsService } from './modules/fulfillment/returns.service';
import { BuyerService } from './modules/b2b/buyer.service';
import { CompaniesService } from './modules/b2b/companies.service';
import { RfqsService } from './modules/b2b/rfqs.service';
import { CheckoutService } from './modules/orders/checkout.service';
import {
  OrdersController,
  PaymentWebhooksController,
  StorefrontOrdersController,
} from './modules/orders/orders.controller';
import { OrdersService } from './modules/orders/orders.service';
import { PaymentsService } from './modules/orders/payments.service';
import { QuotationsService } from './modules/orders/quotations.service';
import { QuoteService } from './modules/pricing/quote.service';
import { RatesService } from './modules/pricing/rates.service';
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
        InventoryController,
        IntegrationsController,
        PricingController,
        StorefrontPricingController,
        OrdersController,
        StorefrontOrdersController,
        PaymentWebhooksController,
        CompaniesController,
        CustomersController,
        StorefrontAccountController,
        FulfillmentController,
        OnlineStoreController,
        DiscountsController,
        MarketingController,
        ReportsController,
        StorefrontContentController,
        BuyerController,
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
        InventoryQueryService,
        InventoryService,
        ConnectionsService,
        SyncService,
        RatesService,
        PricingService,
        QuoteService,
        OrdersService,
        PaymentsService,
        CheckoutService,
        QuotationsService,
        CompaniesService,
        RfqsService,
        BuyerService,
        CustomerAuthService,
        AccountService,
        CustomersService,
        FulfillmentService,
        ReturnsService,
        RefundsService,
        PromotionsService,
        DiscountsService,
        MarketingService,
        OnlineStoreService,
        ReportsService,
      ],
    };
  }
}
