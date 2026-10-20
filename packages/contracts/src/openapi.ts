import { OpenAPIRegistry, OpenApiGeneratorV31, type RouteConfig } from '@asteasolutions/zod-to-openapi';
import { IdParam, PageQuery, Uuid } from './common';
import { ErrorBody } from './errors';
import { z } from './z';
import * as A from './dto/auth';
import * as T from './dto/tenant';
import * as M from './dto/admin';
import * as S from './dto/storefront';
import * as C from './dto/catalog';
import * as J from './dto/jewellery';
import * as I from './dto/inventory';
import * as X from './dto/integrations';
import * as P from './dto/pricing';
import * as O from './dto/orders';
import * as B from './dto/b2b';
import * as F from './dto/fulfillment';
import * as CU from './dto/customers';
import * as G from './dto/growth';
import * as OP from './dto/ops';

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';
type Scope = 'auth' | 'admin' | 'platform' | 'storefront' | 'system';

export interface ApiRouteDoc {
  method: Method;
  path: string; // OpenAPI style: /v1/admin/stores/{id}
  scope: Scope;
  summary: string;
  permission?: string;
  idempotent?: boolean;
  params?: z.AnyZodObject;
  query?: z.AnyZodObject;
  body?: z.ZodTypeAny;
  response?: z.ZodTypeAny;
  status?: 200 | 201 | 202 | 204;
  errors?: number[];
  /** multipart/form-data upload with a single "file" field. */
  multipart?: boolean;
  /** Response is raw bytes (image). */
  binary?: boolean;
  /** Response is a CSV download. */
  csv?: boolean;
}

const json = (schema: z.ZodTypeAny, description = 'OK') => ({
  description,
  content: { 'application/json': { schema } },
});

/** Single source of truth for documented routes. `openapi.spec.ts` asserts the Nest app matches this list. */
export const API_ROUTES: ApiRouteDoc[] = [
  // ---- system ----
  { method: 'get', path: '/health/live', scope: 'system', summary: 'Liveness probe', response: S.HealthResponse },
  { method: 'get', path: '/health/ready', scope: 'system', summary: 'Readiness probe (DB + Redis)', response: S.HealthResponse, errors: [503] },
  // ---- auth ----
  { method: 'post', path: '/v1/auth/login', scope: 'auth', summary: 'Log in (sets audience-specific session cookie)', body: A.LoginRequest, response: A.MeResponse, errors: [400, 401, 423, 429] },
  { method: 'post', path: '/v1/auth/logout', scope: 'auth', summary: 'Revoke current session', query: z.object({ audience: A.Audience }), status: 204, errors: [401] },
  { method: 'post', path: '/v1/auth/logout-all', scope: 'auth', summary: 'Revoke all sessions of the current user', query: z.object({ audience: A.Audience }), status: 204, errors: [401] },
  { method: 'get', path: '/v1/auth/me', scope: 'auth', summary: 'Current user, memberships, platform role', query: z.object({ audience: A.Audience }), response: A.MeResponse, errors: [401] },
  { method: 'post', path: '/v1/auth/invitations/preview', scope: 'auth', summary: 'Preview an invitation by token', body: A.InvitationPreviewRequest, response: A.InvitationPreviewResponse, errors: [400, 404] },
  { method: 'post', path: '/v1/auth/invitations/accept', scope: 'auth', summary: 'Accept invitation (create account or confirm existing)', body: A.AcceptInvitationRequest, response: A.AcceptInvitationResponse, errors: [400, 401, 404, 409] },
  // ---- admin (merchant) ----
  { method: 'get', path: '/v1/admin/context', scope: 'admin', summary: 'Resolved tenant, permissions, entitlements and navigation', response: M.AdminContext },
  { method: 'get', path: '/v1/admin/home', scope: 'admin', summary: 'Home summary with real counts and setup checklist', response: M.HomeSummary },
  { method: 'get', path: '/v1/admin/settings/general', scope: 'admin', permission: 'settings.read', summary: 'Business settings', response: M.TenantSettings },
  { method: 'patch', path: '/v1/admin/settings/general', scope: 'admin', permission: 'settings.manage', summary: 'Update business settings', body: M.UpdateTenantSettingsRequest, response: M.TenantSettings, errors: [400, 409] },
  { method: 'get', path: '/v1/admin/stores', scope: 'admin', permission: 'stores.read', summary: 'List stores', query: M.StoreListQuery, response: M.StorePage },
  { method: 'post', path: '/v1/admin/stores', scope: 'admin', permission: 'stores.manage', summary: 'Create store', body: M.CreateStoreRequest, response: M.Store, status: 201, errors: [400, 409] },
  { method: 'get', path: '/v1/admin/stores/{id}', scope: 'admin', permission: 'stores.read', summary: 'Get store', params: IdParam, response: M.Store, errors: [404] },
  { method: 'patch', path: '/v1/admin/stores/{id}', scope: 'admin', permission: 'stores.manage', summary: 'Update store', params: IdParam, body: M.UpdateStoreRequest, response: M.Store, errors: [400, 404, 409] },
  { method: 'get', path: '/v1/admin/channels', scope: 'admin', permission: 'stores.read', summary: 'List channels', query: M.ChannelListQuery, response: M.ChannelPage },
  { method: 'post', path: '/v1/admin/channels', scope: 'admin', permission: 'stores.manage', summary: 'Create channel (type must be entitled)', body: M.CreateChannelRequest, response: M.Channel, status: 201, errors: [400, 403, 404, 409] },
  { method: 'get', path: '/v1/admin/channels/{id}', scope: 'admin', permission: 'stores.read', summary: 'Get channel', params: IdParam, response: M.Channel, errors: [404] },
  { method: 'patch', path: '/v1/admin/channels/{id}', scope: 'admin', permission: 'stores.manage', summary: 'Update channel incl. theme tokens', params: IdParam, body: M.UpdateChannelRequest, response: M.Channel, errors: [400, 404, 409] },
  { method: 'get', path: '/v1/admin/locations', scope: 'admin', permission: 'locations.read', summary: 'List locations (filtered by membership location scope)', query: M.LocationListQuery, response: M.LocationPage },
  { method: 'post', path: '/v1/admin/locations', scope: 'admin', permission: 'locations.manage', summary: 'Create location (unscoped members only)', body: M.CreateLocationRequest, response: M.Location, status: 201, errors: [400, 403, 404, 409] },
  { method: 'get', path: '/v1/admin/locations/{id}', scope: 'admin', permission: 'locations.read', summary: 'Get location', params: IdParam, response: M.Location, errors: [404] },
  { method: 'patch', path: '/v1/admin/locations/{id}', scope: 'admin', permission: 'locations.manage', summary: 'Update location', params: IdParam, body: M.UpdateLocationRequest, response: M.Location, errors: [400, 403, 404, 409] },
  { method: 'get', path: '/v1/admin/members', scope: 'admin', permission: 'staff.read', summary: 'List staff members', query: M.MemberListQuery, response: M.MemberPage },
  { method: 'patch', path: '/v1/admin/members/{id}', scope: 'admin', permission: 'staff.manage', summary: 'Change roles, status or location scope', params: IdParam, body: M.UpdateMemberRequest, response: M.Member, errors: [400, 403, 404, 409] },
  { method: 'get', path: '/v1/admin/invitations', scope: 'admin', permission: 'staff.read', summary: 'List invitations', query: M.InvitationListQuery, response: M.InvitationPage },
  { method: 'post', path: '/v1/admin/invitations', scope: 'admin', permission: 'staff.manage', idempotent: true, summary: 'Invite staff (link returned once)', body: M.CreateInvitationRequest, response: M.CreateInvitationResponse, status: 201, errors: [400, 403, 409, 422] },
  { method: 'post', path: '/v1/admin/invitations/{id}/revoke', scope: 'admin', permission: 'staff.manage', summary: 'Revoke pending invitation', params: IdParam, response: M.Invitation, errors: [404, 409] },
  { method: 'get', path: '/v1/admin/roles', scope: 'admin', permission: 'roles.read', summary: 'List roles', response: M.RoleList },
  { method: 'post', path: '/v1/admin/roles', scope: 'admin', permission: 'roles.manage', summary: 'Create custom role', body: M.CreateRoleRequest, response: M.Role, status: 201, errors: [400, 403, 409] },
  { method: 'patch', path: '/v1/admin/roles/{id}', scope: 'admin', permission: 'roles.manage', summary: 'Update custom role', params: IdParam, body: M.UpdateRoleRequest, response: M.Role, errors: [400, 403, 404, 409] },
  { method: 'get', path: '/v1/admin/permissions', scope: 'admin', permission: 'roles.read', summary: 'Permission catalog', response: M.PermissionCatalog },
  { method: 'get', path: '/v1/admin/audit-events', scope: 'admin', permission: 'audit.read', summary: 'Tenant audit log', query: M.AuditQuery, response: M.AuditPage },
  // ---- platform ----
  { method: 'get', path: '/v1/platform/presets', scope: 'platform', permission: 'platform.tenants.read', summary: 'Preset and feature catalog', response: T.PresetCatalogResponse },
  { method: 'get', path: '/v1/platform/tenants', scope: 'platform', permission: 'platform.tenants.read', summary: 'List tenants', query: T.TenantListQuery, response: T.TenantPage },
  { method: 'post', path: '/v1/platform/tenants', scope: 'platform', permission: 'platform.tenants.manage', idempotent: true, summary: 'Provision tenant (store, channels, location, roles, owner invitation)', body: T.CreateTenantRequest, response: T.CreateTenantResponse, status: 201, errors: [400, 409, 422] },
  { method: 'get', path: '/v1/platform/tenants/{id}', scope: 'platform', permission: 'platform.tenants.read', summary: 'Tenant detail', params: IdParam, response: T.TenantDetail, errors: [404] },
  { method: 'patch', path: '/v1/platform/tenants/{id}', scope: 'platform', permission: 'platform.tenants.manage', summary: 'Update tenant profile/preset', params: IdParam, body: T.UpdateTenantRequest, response: T.TenantDetail, errors: [400, 404, 409] },
  { method: 'post', path: '/v1/platform/tenants/{id}/suspend', scope: 'platform', permission: 'platform.tenants.manage', summary: 'Suspend tenant (reason required)', params: IdParam, body: T.TenantStatusChangeRequest, response: T.TenantDetail, errors: [400, 404, 409] },
  { method: 'post', path: '/v1/platform/tenants/{id}/reactivate', scope: 'platform', permission: 'platform.tenants.manage', summary: 'Reactivate tenant (reason required)', params: IdParam, body: T.TenantStatusChangeRequest, response: T.TenantDetail, errors: [400, 404, 409] },
  { method: 'get', path: '/v1/platform/tenants/{id}/entitlements', scope: 'platform', permission: 'platform.tenants.read', summary: 'Tenant feature entitlements', params: IdParam, response: T.EntitlementsResponse, errors: [404] },
  { method: 'put', path: '/v1/platform/tenants/{id}/entitlements', scope: 'platform', permission: 'platform.entitlements.manage', summary: 'Set feature overrides (reason required)', params: IdParam, body: T.UpdateEntitlementsRequest, response: T.EntitlementsResponse, errors: [400, 404] },
  { method: 'get', path: '/v1/platform/audit-events', scope: 'platform', permission: 'platform.audit.read', summary: 'Platform-wide audit log', query: M.PlatformAuditQuery, response: M.AuditPage },
  // ---- storefront ----
  { method: 'get', path: '/v1/storefront/config', scope: 'storefront', summary: 'Resolve verified domain to channel brand/theme config', response: S.StorefrontConfig, errors: [404] },
  // ---- Phase 02: catalog (admin) ----
  { method: 'get', path: '/v1/admin/products', scope: 'admin', permission: 'catalog.read', summary: 'Search/filter/sort products', query: C.ProductListQuery, response: C.ProductPage },
  { method: 'post', path: '/v1/admin/products', scope: 'admin', permission: 'catalog.edit', summary: 'Create product with variants', body: C.CreateProductRequest, response: C.Product, status: 201, errors: [400, 403, 409] },
  { method: 'get', path: '/v1/admin/products/{id}', scope: 'admin', permission: 'catalog.read', summary: 'Product detail (variants, media, publications)', params: IdParam, response: C.Product, errors: [404] },
  { method: 'patch', path: '/v1/admin/products/{id}', scope: 'admin', permission: 'catalog.edit', summary: 'Update product incl. guarded status transitions', params: IdParam, body: C.UpdateProductRequest, response: C.Product, errors: [400, 404, 409] },
  { method: 'post', path: '/v1/admin/products/{id}/variants', scope: 'admin', permission: 'catalog.edit', summary: 'Add variant', params: IdParam, body: C.CreateVariantRequest, response: C.Product, status: 201, errors: [400, 404, 409] },
  { method: 'patch', path: '/v1/admin/products/{id}/variants/{variantId}', scope: 'admin', permission: 'catalog.edit', summary: 'Update variant', params: C.VariantIdParams, body: C.UpdateVariantRequest, response: C.Product, errors: [400, 404, 409] },
  { method: 'post', path: '/v1/admin/products/{id}/media', scope: 'admin', permission: 'catalog.edit', summary: 'Upload image (multipart field "file"; JPEG/PNG/WebP/GIF ≤10 MB, type sniffed)', params: IdParam, multipart: true, response: C.Product, status: 201, errors: [400, 404, 413, 415] },
  { method: 'patch', path: '/v1/admin/products/{id}/media', scope: 'admin', permission: 'catalog.edit', summary: 'Reorder gallery and set alt texts', params: IdParam, body: C.UpdateProductMediaRequest, response: C.Product, errors: [400, 404] },
  { method: 'delete', path: '/v1/admin/products/{id}/media/{mediaId}', scope: 'admin', permission: 'catalog.edit', summary: 'Remove image from product', params: C.MediaParams, response: C.Product, errors: [404] },
  { method: 'get', path: '/v1/admin/media/{id}/content', scope: 'admin', permission: 'catalog.read', summary: 'Image bytes (tenant via X-Tenant-Id or ?tenantId= for <img>)', params: IdParam, binary: true, errors: [404] },
  { method: 'put', path: '/v1/admin/products/{id}/publications/{channelId}', scope: 'admin', permission: 'catalog.publish', summary: 'Publish product to channel', params: C.ChannelParams, response: C.PublicationList, errors: [404, 409] },
  { method: 'delete', path: '/v1/admin/products/{id}/publications/{channelId}', scope: 'admin', permission: 'catalog.publish', summary: 'Unpublish product from channel', params: C.ChannelParams, response: C.PublicationList, errors: [404] },
  { method: 'get', path: '/v1/admin/categories', scope: 'admin', permission: 'catalog.read', summary: 'Category tree (flat, ordered)', response: C.CategoryList },
  { method: 'post', path: '/v1/admin/categories', scope: 'admin', permission: 'catalog.edit', summary: 'Create category', body: C.CreateCategoryRequest, response: C.Category, status: 201, errors: [400, 404, 409] },
  { method: 'patch', path: '/v1/admin/categories/{id}', scope: 'admin', permission: 'catalog.edit', summary: 'Update/move category (cycle-checked)', params: IdParam, body: C.UpdateCategoryRequest, response: C.Category, errors: [400, 404, 409] },
  { method: 'delete', path: '/v1/admin/categories/{id}', scope: 'admin', permission: 'catalog.edit', summary: 'Delete empty category', params: IdParam, status: 204, errors: [404, 409] },
  { method: 'get', path: '/v1/admin/collections', scope: 'admin', permission: 'catalog.read', summary: 'List collections', query: C.CollectionListQuery, response: C.CollectionPage },
  { method: 'post', path: '/v1/admin/collections', scope: 'admin', permission: 'catalog.edit', summary: 'Create collection', body: C.CreateCollectionRequest, response: C.Collection, status: 201, errors: [400, 409] },
  { method: 'get', path: '/v1/admin/collections/{id}', scope: 'admin', permission: 'catalog.read', summary: 'Collection with ordered products', params: IdParam, response: C.CollectionDetail, errors: [404] },
  { method: 'patch', path: '/v1/admin/collections/{id}', scope: 'admin', permission: 'catalog.edit', summary: 'Update collection', params: IdParam, body: C.UpdateCollectionRequest, response: C.CollectionDetail, errors: [400, 404, 409] },
  { method: 'put', path: '/v1/admin/collections/{id}/products', scope: 'admin', permission: 'catalog.edit', summary: 'Replace ordered membership', params: IdParam, body: C.SetCollectionProductsRequest, response: C.CollectionDetail, errors: [400, 404, 409] },
  { method: 'get', path: '/v1/admin/attribute-definitions', scope: 'admin', permission: 'catalog.read', summary: 'Product attribute definitions', response: C.AttributeDefinitionList },
  { method: 'post', path: '/v1/admin/attribute-definitions', scope: 'admin', permission: 'catalog.edit', summary: 'Create attribute definition', body: C.CreateAttributeDefinitionRequest, response: C.AttributeDefinition, status: 201, errors: [400, 409] },
  { method: 'patch', path: '/v1/admin/attribute-definitions/{id}', scope: 'admin', permission: 'catalog.edit', summary: 'Update attribute definition (type immutable)', params: IdParam, body: C.UpdateAttributeDefinitionRequest, response: C.AttributeDefinition, errors: [400, 404, 409] },
  { method: 'get', path: '/v1/admin/saved-views', scope: 'admin', permission: 'catalog.read', summary: 'Own and shared saved views', query: z.object({ resource: z.literal('products') }), response: C.SavedViewList },
  { method: 'post', path: '/v1/admin/saved-views', scope: 'admin', permission: 'catalog.read', summary: 'Create saved view', body: C.CreateSavedViewRequest, response: C.SavedView, status: 201, errors: [400, 409] },
  { method: 'patch', path: '/v1/admin/saved-views/{id}', scope: 'admin', permission: 'catalog.read', summary: 'Update own saved view', params: IdParam, body: C.UpdateSavedViewRequest, response: C.SavedView, errors: [400, 404, 409] },
  { method: 'delete', path: '/v1/admin/saved-views/{id}', scope: 'admin', permission: 'catalog.read', summary: 'Delete own saved view', params: IdParam, status: 204, errors: [404] },
  { method: 'get', path: '/v1/admin/catalog/imports', scope: 'admin', permission: 'catalog.edit', summary: 'List CSV import batches', query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), cursor: z.string().optional() }), response: C.ImportBatchPage },
  { method: 'post', path: '/v1/admin/catalog/imports', scope: 'admin', permission: 'catalog.edit', idempotent: true, summary: 'Upload CSV and build a validated preview (writes no products)', body: C.CreateImportRequest, response: C.ImportBatch, status: 201, errors: [400, 413, 422] },
  { method: 'get', path: '/v1/admin/catalog/imports/{id}', scope: 'admin', permission: 'catalog.edit', summary: 'Import batch with per-row results', params: IdParam, response: C.ImportBatch, errors: [404] },
  { method: 'post', path: '/v1/admin/catalog/imports/{id}/commit', scope: 'admin', permission: 'catalog.edit', summary: 'Atomically apply valid rows (re-validated; once only)', params: IdParam, response: C.ImportBatch, errors: [404, 409] },
  { method: 'post', path: '/v1/admin/catalog/imports/{id}/discard', scope: 'admin', permission: 'catalog.edit', summary: 'Discard a previewed batch', params: IdParam, response: C.ImportBatch, errors: [404, 409] },
  // ---- Phase 02: storefront catalog (domain-resolved, published + active only, no prices) ----
  { method: 'get', path: '/v1/storefront/catalog/products', scope: 'storefront', summary: 'Products published to this channel', query: C.StorefrontProductQuery, response: C.StorefrontProductPage, errors: [404] },
  { method: 'get', path: '/v1/storefront/catalog/products/{slug}', scope: 'storefront', summary: 'Product detail by slug', params: C.SlugParam, response: C.StorefrontProduct, errors: [404] },
  { method: 'get', path: '/v1/storefront/catalog/categories', scope: 'storefront', summary: 'Categories', response: C.StorefrontCategoryList, errors: [404] },
  { method: 'get', path: '/v1/storefront/catalog/collections/{slug}', scope: 'storefront', summary: 'Active collection', params: C.SlugParam, response: C.StorefrontCollection, errors: [404] },
  { method: 'get', path: '/v1/storefront/media/{id}', scope: 'storefront', summary: 'Image of a product published to this channel', params: IdParam, binary: true, errors: [404] },
  // ---- Phase 03: jewellery ----
  { method: 'get', path: '/v1/admin/jewellery/settings', scope: 'admin', permission: 'catalog.read', summary: 'Jewellery settings (tolerance, fine rounding, HUID format)', response: J.JewellerySettings },
  { method: 'put', path: '/v1/admin/jewellery/settings', scope: 'admin', permission: 'jewellery.edit', summary: 'Update jewellery settings', body: J.UpdateJewellerySettingsRequest, response: J.JewellerySettings, errors: [400, 409] },
  { method: 'get', path: '/v1/admin/jewellery/purities', scope: 'admin', permission: 'catalog.read', summary: 'Purity definitions (metal, code, fineness)', response: J.PurityList },
  { method: 'post', path: '/v1/admin/jewellery/purities', scope: 'admin', permission: 'jewellery.edit', summary: 'Create purity definition', body: J.CreatePurityRequest, response: J.PurityDefinition, status: 201, errors: [400, 409] },
  { method: 'patch', path: '/v1/admin/jewellery/purities/{id}', scope: 'admin', permission: 'jewellery.edit', summary: 'Update/confirm purity (affects future computations only)', params: IdParam, body: J.UpdatePurityRequest, response: J.PurityDefinition, errors: [400, 404, 409] },
  { method: 'get', path: '/v1/admin/products/{id}/variants/{variantId}/jewellery-spec', scope: 'admin', permission: 'catalog.read', summary: 'Variant jewellery spec (design measurements)', params: J.VariantParams, response: J.JewellerySpec, errors: [404] },
  { method: 'put', path: '/v1/admin/products/{id}/variants/{variantId}/jewellery-spec', scope: 'admin', permission: 'jewellery.edit', summary: 'Create/replace variant jewellery spec', params: J.VariantParams, body: J.PutJewellerySpecRequest, response: J.JewellerySpec, errors: [400, 403, 404, 409] },
  { method: 'get', path: '/v1/admin/serial-items', scope: 'admin', permission: 'catalog.read', summary: 'Search serialized items (tag, HUID, SKU)', query: J.SerialItemListQuery, response: J.SerialItemPage },
  { method: 'post', path: '/v1/admin/serial-items', scope: 'admin', permission: 'jewellery.edit', summary: 'Create one serialized item with actual measurements', body: J.CreateSerialItemRequest, response: J.SerialItem, status: 201, errors: [400, 403, 404, 409] },
  { method: 'post', path: '/v1/admin/serial-items/bulk', scope: 'admin', permission: 'jewellery.edit', summary: 'Bulk add items for a variant (atomic; dryRun previews)', body: J.BulkSerialItemsRequest, response: J.BulkSerialItemsResponse, errors: [400, 403, 404, 409] },
  { method: 'get', path: '/v1/admin/serial-items/{id}', scope: 'admin', permission: 'catalog.read', summary: 'Serialized item detail', params: IdParam, response: J.SerialItem, errors: [404] },
  { method: 'patch', path: '/v1/admin/serial-items/{id}', scope: 'admin', permission: 'jewellery.edit', summary: 'Update item (edit policy: reasons, HUID restrictions, retired read-only)', params: IdParam, body: J.UpdateSerialItemRequest, response: J.SerialItem, errors: [400, 403, 404, 409] },
  { method: 'post', path: '/v1/admin/serial-items/{id}/review', scope: 'admin', permission: 'jewellery.review', summary: 'Approve/reject a weight exception (reviewer ≠ editor)', params: IdParam, body: J.ReviewSerialItemRequest, response: J.SerialItem, errors: [400, 403, 404, 409] },
  // ---- Phase 04: inventory ----
  { method: 'get', path: '/v1/admin/inventory/summary', scope: 'admin', permission: 'inventory.read', summary: 'Inventory dashboard counters (low/out of stock, holds, transfers, issues)', response: I.InventorySummary },
  { method: 'get', path: '/v1/admin/inventory/levels', scope: 'admin', permission: 'inventory.read', summary: 'Stock levels and ATP per variant (filter by location/channel/stock state)', query: I.StockLevelQuery, response: I.StockLevelPage, errors: [400] },
  { method: 'get', path: '/v1/admin/inventory/variants/{id}', scope: 'admin', permission: 'inventory.read', summary: 'Variant stock: balances per location/condition, ATP by location/channel, pieces', params: IdParam, response: I.VariantStock, errors: [404] },
  { method: 'put', path: '/v1/admin/inventory/variants/{id}/settings', scope: 'admin', permission: 'inventory.adjust', summary: 'Variant stock settings (tracking, unit, buffer, low-stock threshold)', params: IdParam, body: I.UpdateVariantStockSettingsRequest, response: I.VariantStockSettings, errors: [400, 403, 404, 409] },
  { method: 'get', path: '/v1/admin/inventory/movements', scope: 'admin', permission: 'inventory.read', summary: 'Stock ledger (append-only movements)', query: I.MovementQuery, response: I.StockMovementPage, errors: [400] },
  { method: 'get', path: '/v1/admin/inventory/settings', scope: 'admin', permission: 'inventory.read', summary: 'Tenant stock settings', response: I.StockSettings },
  { method: 'put', path: '/v1/admin/inventory/settings', scope: 'admin', permission: 'inventory.adjust', summary: 'Update tenant stock settings (buffer, hold TTL, low-stock threshold)', body: I.UpdateStockSettingsRequest, response: I.StockSettings, errors: [400, 409] },
  { method: 'get', path: '/v1/admin/inventory/channels', scope: 'admin', permission: 'inventory.read', summary: 'Which locations feed each channel', response: I.ChannelStockLocationsList },
  { method: 'put', path: '/v1/admin/inventory/channels/{id}/locations', scope: 'admin', permission: 'stores.manage', summary: 'Set the stock locations of a channel (empty = all)', params: IdParam, body: I.PutChannelLocationsRequest, response: I.ChannelStockLocations, errors: [400, 404] },
  { method: 'post', path: '/v1/admin/inventory/receipts', scope: 'admin', permission: 'inventory.adjust', idempotent: true, summary: 'Receive stock (quantities or exact serialized pieces); a reference posts once', body: I.ReceiptRequest, response: I.StockOperationResult, status: 201, errors: [400, 403, 404, 409, 422] },
  { method: 'post', path: '/v1/admin/inventory/adjustments', scope: 'admin', permission: 'inventory.adjust', idempotent: true, summary: 'Adjust stock with a reason code (never below reserved + committed)', body: I.AdjustmentRequest, response: I.StockOperationResult, status: 201, errors: [400, 403, 404, 409, 422] },
  { method: 'post', path: '/v1/admin/inventory/condition-changes', scope: 'admin', permission: 'inventory.adjust', summary: 'Move stock between sellable / damaged / quarantine', body: I.ConditionChangeRequest, response: I.StockOperationResult, status: 201, errors: [400, 403, 404, 409] },
  { method: 'post', path: '/v1/admin/inventory/serial-items/{id}/write-off', scope: 'admin', permission: 'inventory.adjust', summary: 'Write off one serialized piece (lost, destroyed, melted)', params: IdParam, body: I.WriteOffRequest, response: I.StockOperationResult, status: 201, errors: [400, 403, 404, 409] },
  { method: 'get', path: '/v1/admin/inventory/reservations', scope: 'admin', permission: 'inventory.read', summary: 'Reservations (held, committed, released, expired)', query: I.ReservationListQuery, response: I.ReservationPage, errors: [400] },
  { method: 'post', path: '/v1/admin/inventory/reservations', scope: 'admin', permission: 'inventory.reserve', idempotent: true, summary: 'Hold stock or one exact piece (row-locked ATP check, TTL)', body: I.CreateReservationRequest, response: I.Reservation, status: 201, errors: [400, 403, 404, 409, 422] },
  { method: 'post', path: '/v1/admin/inventory/reservations/{id}/commit', scope: 'admin', permission: 'inventory.reserve', summary: 'Commit a held reservation (fails if it expired)', params: IdParam, response: I.Reservation, errors: [404, 409] },
  { method: 'post', path: '/v1/admin/inventory/reservations/{id}/release', scope: 'admin', permission: 'inventory.reserve', summary: 'Release a held or committed reservation', params: IdParam, body: I.ReleaseReservationRequest, response: I.Reservation, errors: [400, 404, 409] },
  { method: 'get', path: '/v1/admin/inventory/transfers', scope: 'admin', permission: 'inventory.read', summary: 'Transfers between locations', query: I.TransferListQuery, response: I.TransferPage, errors: [400] },
  { method: 'post', path: '/v1/admin/inventory/transfers', scope: 'admin', permission: 'inventory.transfer', idempotent: true, summary: 'Dispatch a transfer (stock moves to in transit at the destination)', body: I.CreateTransferRequest, response: I.Transfer, status: 201, errors: [400, 403, 404, 409, 422] },
  { method: 'get', path: '/v1/admin/inventory/transfers/{id}', scope: 'admin', permission: 'inventory.read', summary: 'Transfer detail', params: IdParam, response: I.Transfer, errors: [404] },
  { method: 'post', path: '/v1/admin/inventory/transfers/{id}/receive', scope: 'admin', permission: 'inventory.transfer', summary: 'Receive a transfer at the destination', params: IdParam, body: I.TransferActionRequest, response: I.Transfer, errors: [400, 403, 404, 409] },
  { method: 'post', path: '/v1/admin/inventory/transfers/{id}/cancel', scope: 'admin', permission: 'inventory.transfer', summary: 'Cancel an in-transit transfer (stock returns to the source)', params: IdParam, body: I.TransferActionRequest, response: I.Transfer, errors: [400, 403, 404, 409] },
  { method: 'get', path: '/v1/admin/inventory/counts', scope: 'admin', permission: 'inventory.read', summary: 'Stocktakes / stock snapshots', query: I.StockCountListQuery, response: I.StockCountPage, errors: [400] },
  { method: 'post', path: '/v1/admin/inventory/counts', scope: 'admin', permission: 'inventory.adjust', summary: 'Submit a count (dryRun previews variance; stale as-of is recorded, not applied)', body: I.CreateStockCountRequest, response: I.StockCount, status: 201, errors: [400, 403, 404, 409] },
  { method: 'get', path: '/v1/admin/inventory/counts/{id}', scope: 'admin', permission: 'inventory.read', summary: 'Stock count detail', params: IdParam, response: I.StockCount, errors: [404] },
  { method: 'get', path: '/v1/admin/inventory/issues', scope: 'admin', permission: 'inventory.read', summary: 'Reconciliation issues', query: I.IssueListQuery, response: I.ReconciliationIssuePage, errors: [400] },
  { method: 'post', path: '/v1/admin/inventory/issues/{id}/resolve', scope: 'admin', permission: 'inventory.adjust', summary: 'Resolve an issue with a note', params: IdParam, body: I.ResolveIssueRequest, response: I.ReconciliationIssue, errors: [400, 404, 409] },
  { method: 'post', path: '/v1/admin/inventory/reconcile', scope: 'admin', permission: 'inventory.adjust', summary: 'Run reconciliation now (ledger vs balances, reservations, serialized pieces)', response: I.ReconcileResponse },
  // ---- Phase 05: integrations (connector framework) ----
  { method: 'get', path: '/v1/admin/integrations/connectors', scope: 'admin', permission: 'integrations.read', summary: 'Connector catalog with honest status, blockers and vendor discovery', response: X.ConnectorCatalog },
  { method: 'put', path: '/v1/admin/integrations/connectors/{key}/discovery', scope: 'admin', permission: 'integrations.manage', summary: 'Record the vendor discovery checklist for a blocked connector', params: X.ConnectorKeyParam, body: X.PutDiscoveryRequest, response: X.ConnectorCatalog, errors: [400, 404, 409] },
  { method: 'get', path: '/v1/admin/integrations/connections', scope: 'admin', permission: 'integrations.read', summary: 'Connections with freshness and exception counts', response: X.ConnectionList },
  { method: 'post', path: '/v1/admin/integrations/connections', scope: 'admin', permission: 'integrations.manage', summary: 'Create a connection (available connectors only; credential reference, never a secret)', body: X.CreateConnectionRequest, response: X.Connection, status: 201, errors: [400, 409] },
  { method: 'get', path: '/v1/admin/integrations/connections/{id}', scope: 'admin', permission: 'integrations.read', summary: 'Connection detail', params: IdParam, response: X.Connection, errors: [404] },
  { method: 'patch', path: '/v1/admin/integrations/connections/{id}', scope: 'admin', permission: 'integrations.manage', summary: 'Update name, status, credential reference, settings or field ownership (reason required for ownership/disconnect)', params: IdParam, body: X.UpdateConnectionRequest, response: X.Connection, errors: [400, 404, 409] },
  { method: 'post', path: '/v1/admin/integrations/connections/{id}/test', scope: 'admin', permission: 'integrations.manage', summary: 'Test the connection', params: IdParam, response: z.object({ ok: z.boolean(), message: z.string() }), errors: [404] },
  { method: 'get', path: '/v1/admin/integrations/connections/{id}/mappings', scope: 'admin', permission: 'integrations.read', summary: 'Field mapping versions', params: IdParam, response: X.FieldMappingList, errors: [404] },
  { method: 'post', path: '/v1/admin/integrations/connections/{id}/mappings', scope: 'admin', permission: 'integrations.manage', summary: 'Publish a new mapping version (becomes active)', params: IdParam, body: X.CreateMappingRequest, response: X.FieldMapping, status: 201, errors: [400, 404] },
  { method: 'post', path: '/v1/admin/integrations/mappings/preview', scope: 'admin', permission: 'integrations.read', summary: 'Preview a mapping on sample rows (writes nothing)', body: X.MappingPreviewRequest, response: X.MappingPreviewResponse, errors: [400] },
  { method: 'post', path: '/v1/admin/integrations/connections/{id}/jobs/file', scope: 'admin', permission: 'integrations.manage', summary: 'Upload a CSV/XLSX file and stage a preview job (writes no catalogue or stock)', params: IdParam, body: X.FilePreviewRequest, response: X.SyncJob, status: 201, errors: [400, 403, 404, 409, 413] },
  { method: 'post', path: '/v1/admin/integrations/connections/{id}/jobs/pull', scope: 'admin', permission: 'integrations.manage', summary: 'Pull from the source (simulator) and stage a preview job', params: IdParam, response: X.SyncJob, status: 201, errors: [403, 404, 409] },
  { method: 'get', path: '/v1/admin/integrations/jobs', scope: 'admin', permission: 'integrations.read', summary: 'Sync jobs', query: X.SyncJobListQuery, response: X.SyncJobPage, errors: [400] },
  { method: 'get', path: '/v1/admin/integrations/jobs/{id}', scope: 'admin', permission: 'integrations.read', summary: 'Sync job detail with counts', params: IdParam, response: X.SyncJob, errors: [404] },
  { method: 'get', path: '/v1/admin/integrations/jobs/{id}/rows', scope: 'admin', permission: 'integrations.read', summary: 'Staged rows with action and errors', params: IdParam, query: X.SyncJobRowQuery, response: X.SyncJobRowPage, errors: [400, 404] },
  { method: 'get', path: '/v1/admin/integrations/jobs/{id}/errors.csv', scope: 'admin', permission: 'integrations.read', summary: 'Download rows with errors (original columns + messages)', params: IdParam, csv: true, errors: [404] },
  { method: 'post', path: '/v1/admin/integrations/jobs/{id}/commit', scope: 'admin', permission: 'integrations.manage', summary: 'Apply a previewed job (atomic, or partial = valid rows only)', params: IdParam, body: X.CommitJobRequest, response: X.SyncJob, errors: [403, 404, 409] },
  { method: 'post', path: '/v1/admin/integrations/jobs/{id}/discard', scope: 'admin', permission: 'integrations.manage', summary: 'Discard a previewed job', params: IdParam, response: X.SyncJob, errors: [404, 409] },
  { method: 'get', path: '/v1/admin/integrations/connections/{id}/records', scope: 'admin', permission: 'integrations.read', summary: 'External ID → product/piece map', params: IdParam, query: X.ExternalRecordQuery, response: X.ExternalRecordPage, errors: [400, 404] },
  { method: 'get', path: '/v1/admin/integrations/connections/{id}/simulator', scope: 'admin', permission: 'integrations.read', summary: 'Simulator state (test double)', params: IdParam, response: X.SimulatorState, errors: [404] },
  { method: 'post', path: '/v1/admin/integrations/connections/{id}/simulator/advance', scope: 'admin', permission: 'integrations.manage', summary: 'Advance the simulator one documented change', params: IdParam, response: X.SimulatorState, errors: [404] },
  { method: 'post', path: '/v1/admin/integrations/connections/{id}/simulator/failures', scope: 'admin', permission: 'integrations.manage', summary: 'Inject simulated outages/timeouts for order export', params: IdParam, body: X.SimulatorFailuresRequest, response: X.SimulatorState, errors: [400, 404] },
  { method: 'post', path: '/v1/admin/integrations/connections/{id}/outbound/test-order', scope: 'admin', permission: 'integrations.manage', summary: 'Queue a test order export (idempotent by reference)', params: IdParam, body: X.TestOrderRequest, response: X.OutboundCommand, status: 201, errors: [400, 404, 409, 422] },
  { method: 'get', path: '/v1/admin/integrations/outbound', scope: 'admin', permission: 'integrations.read', summary: 'Outbound commands (order export) and their delivery state', query: X.OutboundListQuery, response: X.OutboundCommandPage, errors: [400] },
  { method: 'post', path: '/v1/admin/integrations/outbound/{id}/retry', scope: 'admin', permission: 'integrations.manage', summary: 'Retry a failed command (same reference, no duplicate ERP order)', params: IdParam, response: X.OutboundCommand, errors: [404, 409] },
  { method: 'post', path: '/v1/admin/integrations/connections/{id}/reconcile', scope: 'admin', permission: 'integrations.manage', summary: 'Compare the last ERP stock snapshot with current balances', params: IdParam, response: X.ReconcileConnectionResponse, errors: [403, 404] },
  { method: 'get', path: '/v1/admin/integrations/connections/{id}/discrepancies', scope: 'admin', permission: 'integrations.read', summary: 'Open/resolved discrepancies for a connection', params: IdParam, query: z.object({ status: z.enum(['open', 'resolved']).default('open') }), response: z.object({ items: z.array(I.ReconciliationIssue) }), errors: [404] },
  { method: 'post', path: '/v1/admin/integrations/discrepancies/{id}/resolve', scope: 'admin', permission: 'reconciliation.resolve', summary: 'Resolve: accept the ERP value (ledger adjustment) or keep ours, with a note', params: IdParam, body: X.ResolveDiscrepancyRequest, response: I.ReconciliationIssue, errors: [400, 403, 404, 409] },
  // ---- Phase 06: metal rates & pricing ----
  { method: 'get', path: '/v1/admin/rates/current', scope: 'admin', permission: 'rates.read', summary: 'Current approved rate per purity with freshness and pending proposals', response: P.CurrentRates },
  { method: 'get', path: '/v1/admin/rates', scope: 'admin', permission: 'rates.read', summary: 'Rate history (proposed, approved, rejected)', query: P.MetalRateListQuery, response: P.MetalRatePage },
  { method: 'post', path: '/v1/admin/rates', scope: 'admin', permission: 'rates.edit', summary: 'Propose a manual metal rate (needs a second person to approve)', body: P.ProposeRateRequest, response: P.MetalRate, status: 201, errors: [400, 404] },
  { method: 'get', path: '/v1/admin/rates/sources', scope: 'admin', permission: 'rates.read', summary: 'Rate sources and the provider registry (honest tiers)', response: P.RateSourceList },
  { method: 'post', path: '/v1/admin/rates/sources', scope: 'admin', permission: 'rates.edit', summary: 'Add a provider source (secret reference only)', body: P.CreateRateSourceRequest, response: P.RateSource, status: 201, errors: [400, 409] },
  { method: 'post', path: '/v1/admin/rates/sources/{id}/pull', scope: 'admin', permission: 'rates.edit', summary: 'Pull values from a provider adapter as proposals (simulator only in this build)', params: IdParam, body: P.PullRatesRequest, response: P.PullRatesResponse, errors: [404, 409] },
  { method: 'get', path: '/v1/admin/rates/{id}', scope: 'admin', permission: 'rates.read', summary: 'Metal rate detail', params: IdParam, response: P.MetalRate, errors: [404] },
  { method: 'post', path: '/v1/admin/rates/{id}/approve', scope: 'admin', permission: 'rates.approve', summary: 'Approve a proposed rate (approver must differ from proposer); publishes it when effective', params: IdParam, body: P.ApproveRateRequest, response: P.MetalRate, errors: [403, 404, 409] },
  { method: 'post', path: '/v1/admin/rates/{id}/reject', scope: 'admin', permission: 'rates.approve', summary: 'Reject a proposed rate with a reason', params: IdParam, body: P.RejectRateRequest, response: P.MetalRate, errors: [404, 409] },
  { method: 'get', path: '/v1/admin/pricing/settings', scope: 'admin', permission: 'pricing.read', summary: 'Quote TTL, rate max age, stale policy, rule review', response: P.PricingSettings },
  { method: 'put', path: '/v1/admin/pricing/settings', scope: 'admin', permission: 'pricing.edit', summary: 'Update pricing settings', body: P.UpdatePricingSettingsRequest, response: P.PricingSettings, errors: [400, 409] },
  { method: 'get', path: '/v1/admin/pricing/options', scope: 'admin', permission: 'pricing.read', summary: 'Purities, channels, tax rules and currency for pricing forms', response: P.PricingCatalogOptions },
  { method: 'get', path: '/v1/admin/pricing/tax-rules', scope: 'admin', permission: 'pricing.read', summary: 'Merchant-entered tax rules (pending validation until marked validated)', response: P.TaxRuleList },
  { method: 'post', path: '/v1/admin/pricing/tax-rules', scope: 'admin', permission: 'pricing.edit', summary: 'Create a tax rule (starts pending validation)', body: P.CreateTaxRuleRequest, response: P.TaxRule, status: 201, errors: [400] },
  { method: 'patch', path: '/v1/admin/pricing/tax-rules/{id}', scope: 'admin', permission: 'pricing.edit', summary: 'Update or validate a tax rule', params: IdParam, body: P.UpdateTaxRuleRequest, response: P.TaxRule, errors: [400, 404, 409] },
  { method: 'get', path: '/v1/admin/pricing/books', scope: 'admin', permission: 'pricing.read', summary: 'Price books', response: P.PriceBookList },
  { method: 'post', path: '/v1/admin/pricing/books', scope: 'admin', permission: 'pricing.edit', summary: 'Create a price book', body: P.CreatePriceBookRequest, response: P.PriceBook, status: 201, errors: [400, 409] },
  { method: 'get', path: '/v1/admin/pricing/books/{id}', scope: 'admin', permission: 'pricing.read', summary: 'Price book detail', params: IdParam, response: P.PriceBook, errors: [404] },
  { method: 'patch', path: '/v1/admin/pricing/books/{id}', scope: 'admin', permission: 'pricing.edit', summary: 'Update or archive a price book', params: IdParam, body: P.UpdatePriceBookRequest, response: P.PriceBook, errors: [400, 404, 409] },
  { method: 'get', path: '/v1/admin/pricing/books/{id}/list-prices', scope: 'admin', permission: 'pricing.read', summary: 'List prices in a book', params: IdParam, response: P.ListPriceList, errors: [404] },
  { method: 'put', path: '/v1/admin/pricing/books/{id}/list-prices', scope: 'admin', permission: 'pricing.edit', summary: 'Set or remove list prices (null removes)', params: IdParam, body: P.PutListPricesRequest, response: z.object({ updated: z.number().int(), removed: z.number().int() }), errors: [400, 404, 409] },
  { method: 'get', path: '/v1/admin/pricing/books/{id}/rules', scope: 'admin', permission: 'pricing.read', summary: 'Rules in a book (by priority)', params: IdParam, response: P.PriceRuleList, errors: [404] },
  { method: 'post', path: '/v1/admin/pricing/rules', scope: 'admin', permission: 'pricing.edit', summary: 'Create a price rule (starts as draft v1)', body: P.CreatePriceRuleRequest, response: P.PriceRule, status: 201, errors: [400, 404, 409] },
  { method: 'get', path: '/v1/admin/pricing/rules/{id}', scope: 'admin', permission: 'pricing.read', summary: 'Price rule with all versions', params: IdParam, response: P.PriceRule, errors: [404] },
  { method: 'put', path: '/v1/admin/pricing/rules/{id}/draft', scope: 'admin', permission: 'pricing.edit', summary: 'Save the draft version (creates one from the published version if none)', params: IdParam, body: P.SaveRuleDraftRequest, response: P.PriceRule, errors: [400, 404, 409] },
  { method: 'post', path: '/v1/admin/pricing/rules/{id}/publish', scope: 'admin', permission: 'pricing.publish', summary: 'Publish a draft (conflict check; reviewer must differ from author when review is on)', params: IdParam, body: P.PublishRuleRequest, response: P.PriceRule, errors: [403, 404, 409] },
  { method: 'post', path: '/v1/admin/pricing/rules/{id}/retire', scope: 'admin', permission: 'pricing.publish', summary: 'Retire a rule', params: IdParam, body: P.RetireRuleRequest, response: P.PriceRule, errors: [404, 409] },
  { method: 'get', path: '/v1/admin/pricing/items', scope: 'admin', permission: 'pricing.read', summary: 'Find variants and sellable pieces to price (SKU, title, tag)', query: P.PricingItemQuery, response: P.PricingItemResults, errors: [400] },
  { method: 'post', path: '/v1/admin/pricing/calculate', scope: 'admin', permission: 'pricing.read', summary: 'Explainable price for an item or manual measurements (not stored)', body: P.CalculateRequest, response: P.CalculateResponse, errors: [400, 404, 409, 422] },
  { method: 'get', path: '/v1/admin/pricing/quotes', scope: 'admin', permission: 'pricing.read', summary: 'Price quotes', query: P.PriceQuoteListQuery, response: P.PriceQuotePage },
  { method: 'post', path: '/v1/admin/pricing/quotes', scope: 'admin', permission: 'pricing.read', summary: 'Create an immutable, time-limited price quote', body: P.CreateQuoteRequest, response: P.PriceQuote, status: 201, errors: [400, 404, 409, 422] },
  { method: 'get', path: '/v1/admin/pricing/quotes/{id}', scope: 'admin', permission: 'pricing.read', summary: 'Quote detail with frozen breakdown', params: IdParam, response: P.PriceQuote, errors: [404] },
  { method: 'post', path: '/v1/admin/pricing/quotes/{id}/revalidate', scope: 'admin', permission: 'pricing.read', summary: 'Re-price with current rates/rules: unchanged, changed (new quote) or unavailable', params: IdParam, response: P.RevalidateQuoteResponse, errors: [404, 409] },
  { method: 'post', path: '/v1/storefront/pricing-quotes', scope: 'storefront', summary: 'Price quote for published items of the storefront resolved from Host (rate limited)', body: P.StorefrontQuoteRequest, response: P.StorefrontQuote, status: 201, errors: [400, 404, 409, 422, 429] },
  // ---- Phase 07: orders, quotations, checkout ----
  { method: 'get', path: '/v1/admin/order-settings', scope: 'admin', permission: 'orders.read', summary: 'Approval threshold, checkout hold, quotation validity, numbering', response: O.OrderSettings },
  { method: 'put', path: '/v1/admin/order-settings', scope: 'admin', permission: 'settings.manage', summary: 'Update order settings', body: O.UpdateOrderSettingsRequest, response: O.OrderSettings, errors: [400, 409] },
  { method: 'get', path: '/v1/admin/orders', scope: 'admin', permission: 'orders.read', summary: 'Orders (filter by status, payment, channel, origin, number/contact)', query: O.OrderListQuery, response: O.OrderPage },
  { method: 'post', path: '/v1/admin/orders', scope: 'admin', permission: 'orders.manage', idempotent: true, summary: 'Staff order on account: server-priced, held, confirmed or sent for approval', body: O.CreateOrderRequest, response: O.Order, status: 201, errors: [400, 404, 409, 422] },
  { method: 'get', path: '/v1/admin/orders/{id}', scope: 'admin', permission: 'orders.read', summary: 'Order with frozen line snapshots, holds, payments, timeline and ERP exports', params: IdParam, response: O.Order, errors: [404] },
  { method: 'post', path: '/v1/admin/orders/{id}/approve', scope: 'admin', permission: 'orders.approve', summary: 'Approve an order (approver must differ from creator); commits stock', params: IdParam, body: O.ApproveOrderRequest, response: O.Order, errors: [403, 404, 409] },
  { method: 'post', path: '/v1/admin/orders/{id}/reject', scope: 'admin', permission: 'orders.approve', summary: 'Reject an order awaiting approval (releases stock)', params: IdParam, body: O.RejectOrderRequest, response: O.Order, errors: [404, 409] },
  { method: 'post', path: '/v1/admin/orders/{id}/cancel', scope: 'admin', permission: 'orders.manage', summary: 'Cancel with compensation (stock released, refund due if paid)', params: IdParam, body: O.CancelOrderRequest, response: O.Order, errors: [404, 409] },
  { method: 'get', path: '/v1/admin/quotations', scope: 'admin', permission: 'orders.read', summary: 'Sales quotations', query: O.QuotationListQuery, response: O.QuotationPage },
  { method: 'post', path: '/v1/admin/quotations', scope: 'admin', permission: 'orders.manage', summary: 'Create a draft quotation', body: O.CreateQuotationRequest, response: O.Quotation, status: 201, errors: [400, 404, 422] },
  { method: 'get', path: '/v1/admin/quotations/{id}', scope: 'admin', permission: 'orders.read', summary: 'Quotation with its frozen price', params: IdParam, response: O.Quotation, errors: [404] },
  { method: 'patch', path: '/v1/admin/quotations/{id}', scope: 'admin', permission: 'orders.manage', summary: 'Edit a draft quotation', params: IdParam, body: O.UpdateQuotationRequest, response: O.Quotation, errors: [400, 404, 409, 422] },
  { method: 'post', path: '/v1/admin/quotations/{id}/send', scope: 'admin', permission: 'orders.manage', summary: 'Send: freezes the price until the validity date', params: IdParam, body: O.QuotationActionRequest, response: O.Quotation, errors: [404, 409, 422] },
  { method: 'post', path: '/v1/admin/quotations/{id}/accept', scope: 'admin', permission: 'orders.manage', summary: 'Record the buyer acceptance (before expiry)', params: IdParam, body: O.AcceptQuotationRequest, response: O.Quotation, errors: [404, 409] },
  { method: 'post', path: '/v1/admin/quotations/{id}/convert', scope: 'admin', permission: 'orders.manage', summary: 'Create the order at the frozen price', params: IdParam, body: O.ConvertQuotationRequest, response: O.Order, status: 201, errors: [404, 409] },
  { method: 'post', path: '/v1/admin/quotations/{id}/cancel', scope: 'admin', permission: 'orders.manage', summary: 'Cancel a quotation', params: IdParam, body: O.CancelQuotationRequest, response: O.Quotation, errors: [404, 409] },
  { method: 'post', path: '/v1/storefront/carts', scope: 'storefront', summary: 'Create a cart (returns a secret cart token once)', response: O.CreateCartResponse, status: 201, errors: [404, 429] },
  { method: 'get', path: '/v1/storefront/carts/{id}', scope: 'storefront', summary: 'Cart with a fresh server price (X-Cart-Token)', params: IdParam, response: O.Cart, errors: [404, 409, 422, 429] },
  { method: 'put', path: '/v1/storefront/carts/{id}/lines', scope: 'storefront', summary: 'Replace cart lines (validated by pricing; X-Cart-Token)', params: IdParam, body: O.PutCartLinesRequest, response: O.Cart, errors: [400, 404, 409, 422, 429] },
  { method: 'post', path: '/v1/storefront/checkouts', scope: 'storefront', idempotent: true, summary: 'Checkout: re-price (409 PRICE_CHANGED), hold stock, create the order + sandbox payment', body: O.CheckoutRequest, response: O.StorefrontOrder, status: 201, errors: [400, 404, 409, 422, 429] },
  { method: 'get', path: '/v1/storefront/orders/{id}', scope: 'storefront', summary: 'Order status for the cart that placed it (X-Cart-Token)', params: IdParam, response: O.StorefrontOrder, errors: [404, 429] },
  { method: 'post', path: '/v1/storefront/orders/{id}/sandbox-payment', scope: 'storefront', summary: 'SANDBOX ONLY: simulate the PSP outcome (signed callback, no real money)', params: IdParam, body: O.SandboxPayRequest, response: O.StorefrontOrder, errors: [403, 404, 409, 429] },
  { method: 'post', path: '/v1/payments/sandbox/webhook', scope: 'system', summary: 'Sandbox PSP callback (X-Sandbox-Signature HMAC-SHA256, replay protected)', body: O.SandboxWebhook, response: O.WebhookAck, errors: [400, 401, 403, 404, 422] },
  // ---- Phase 08: B2B wholesale ----
  { method: 'get', path: '/v1/admin/companies', scope: 'admin', permission: 'companies.read', summary: 'Companies (sales reps see only assigned companies)', query: B.CompanyListQuery, response: B.CompanyPage },
  { method: 'post', path: '/v1/admin/companies', scope: 'admin', permission: 'companies.manage', summary: 'Create a company (GSTIN format-checked only)', body: B.CreateCompanyRequest, response: B.Company, status: 201, errors: [400, 409] },
  { method: 'get', path: '/v1/admin/companies/{id}', scope: 'admin', permission: 'companies.read', summary: 'Company with locations, buyers and credit summary', params: IdParam, response: B.Company, errors: [404] },
  { method: 'patch', path: '/v1/admin/companies/{id}', scope: 'admin', permission: 'companies.manage', summary: 'Update company terms, credit, rep, price book, catalog, status', params: IdParam, body: B.UpdateCompanyRequest, response: B.Company, errors: [400, 404, 409] },
  { method: 'post', path: '/v1/admin/companies/{id}/locations', scope: 'admin', permission: 'companies.manage', summary: 'Add a company location', params: IdParam, body: B.CreateCompanyLocationRequest, response: B.CompanyLocation, status: 201, errors: [400, 404, 409] },
  { method: 'patch', path: '/v1/admin/companies/{id}/locations/{childId}', scope: 'admin', permission: 'companies.manage', summary: 'Update a company location', params: z.object({ id: Uuid, childId: Uuid }), body: B.UpdateCompanyLocationRequest, response: B.CompanyLocation, errors: [400, 404, 409] },
  { method: 'post', path: '/v1/admin/companies/{id}/buyers', scope: 'admin', permission: 'companies.manage', summary: 'Invite a buyer (single-use link shown once)', params: IdParam, body: B.InviteBuyerRequest, response: B.InviteBuyerResponse, status: 201, errors: [400, 404, 409] },
  { method: 'patch', path: '/v1/admin/companies/{id}/buyers/{childId}', scope: 'admin', permission: 'companies.manage', summary: 'Change a buyer role, locations, order limit or status', params: z.object({ id: Uuid, childId: Uuid }), body: B.UpdateBuyerRequest, response: B.CompanyBuyer, errors: [400, 404, 409] },
  { method: 'get', path: '/v1/admin/companies/{id}/credit', scope: 'admin', permission: 'companies.read', summary: 'Credit ledger (append-only)', params: IdParam, query: PageQuery, response: B.CreditEntryPage, errors: [404] },
  { method: 'post', path: '/v1/admin/companies/{id}/credit', scope: 'admin', permission: 'companies.manage', summary: 'Record a payment, advance or adjustment', params: IdParam, body: B.RecordCreditEntryRequest, response: z.object({ id: Uuid, credit: B.CreditSummary }), status: 201, errors: [400, 404] },
  { method: 'get', path: '/v1/admin/rfqs', scope: 'admin', permission: 'companies.read', summary: 'RFQ inbox', query: B.RfqListQuery, response: B.RfqPage },
  { method: 'get', path: '/v1/admin/rfqs/{id}', scope: 'admin', permission: 'companies.read', summary: 'RFQ with negotiation thread', params: IdParam, response: B.Rfq, errors: [404] },
  { method: 'post', path: '/v1/admin/rfqs/{id}/messages', scope: 'admin', permission: 'orders.manage', summary: 'Reply in the RFQ thread', params: IdParam, body: B.RfqMessageRequest, response: B.Rfq, errors: [404, 409] },
  { method: 'post', path: '/v1/admin/rfqs/{id}/quote', scope: 'admin', permission: 'orders.manage', summary: 'Send a quotation (company prices, frozen until validUntil)', params: IdParam, body: B.QuoteRfqRequest, response: B.Rfq, errors: [400, 404, 409, 422] },
  { method: 'post', path: '/v1/admin/rfqs/{id}/decline', scope: 'admin', permission: 'orders.manage', summary: 'Decline an RFQ with a reason', params: IdParam, body: B.DeclineRfqRequest, response: B.Rfq, errors: [404, 409] },
  { method: 'post', path: '/v1/storefront/b2b/auth/login', scope: 'storefront', summary: 'Buyer sign-in on this B2B portal (sets the buyer session cookie)', body: B.BuyerLoginRequest, response: B.BuyerContext, errors: [401, 403, 404, 423, 429] },
  { method: 'post', path: '/v1/storefront/b2b/auth/logout', scope: 'storefront', summary: 'Buyer sign-out', status: 204, errors: [403] },
  { method: 'get', path: '/v1/storefront/b2b/me', scope: 'storefront', summary: 'Buyer context: companies, chosen company (X-Company-Id), locations, credit', response: B.BuyerContext, errors: [401, 403, 404] },
  { method: 'post', path: '/v1/storefront/b2b/invitations/preview', scope: 'storefront', summary: 'Preview a buyer invitation', body: z.object({ token: z.string() }), response: B.BuyerInvitationPreview, errors: [400, 404] },
  { method: 'post', path: '/v1/storefront/b2b/invitations/accept', scope: 'storefront', summary: 'Accept a buyer invitation (single use)', body: B.AcceptBuyerInvitationRequest, response: z.object({ companyName: z.string(), email: z.string() }), errors: [400, 401, 404] },
  { method: 'get', path: '/v1/storefront/b2b/catalog', scope: 'storefront', summary: "The company's catalog (published on this portal, collection restriction, MOQ)", query: B.BuyerCatalogQuery, response: B.BuyerCatalogPage, errors: [401, 403] },
  { method: 'post', path: '/v1/storefront/b2b/price', scope: 'storefront', summary: 'Company price for bulk lines (SKU / piece tag + quantity), with MOQ and minimum checks', body: B.BuyerPriceRequest, response: B.BuyerPriceResponse, errors: [401, 403, 409, 422] },
  { method: 'post', path: '/v1/storefront/b2b/orders', scope: 'storefront', summary: 'Place an order on account (re-price, credit, buyer limit, approvals, holds)', body: B.BuyerPlaceOrderRequest, response: B.BuyerOrder, status: 201, errors: [400, 401, 403, 404, 409, 422] },
  { method: 'get', path: '/v1/storefront/b2b/orders', scope: 'storefront', summary: "Company orders (the buyer's locations only)", query: B.BuyerOrderListQuery, response: B.BuyerOrderPage, errors: [401, 403] },
  { method: 'get', path: '/v1/storefront/b2b/orders/{id}', scope: 'storefront', summary: 'Company order detail', params: IdParam, response: B.BuyerOrder, errors: [401, 403, 404] },
  { method: 'post', path: '/v1/storefront/b2b/orders/{id}/approve', scope: 'storefront', summary: "Company approver approves an order over a buyer's limit (not their own)", params: IdParam, body: B.BuyerDecisionRequest, response: B.BuyerOrder, errors: [401, 403, 404, 409] },
  { method: 'post', path: '/v1/storefront/b2b/orders/{id}/reject', scope: 'storefront', summary: 'Company approver rejects (stock and credit released)', params: IdParam, body: B.BuyerDecisionRequest, response: B.BuyerOrder, errors: [400, 401, 403, 404, 409] },
  { method: 'post', path: '/v1/storefront/b2b/rfqs', scope: 'storefront', summary: 'Submit an RFQ', body: B.BuyerRfqRequest, response: B.Rfq, status: 201, errors: [400, 401, 403, 422] },
  { method: 'get', path: '/v1/storefront/b2b/rfqs', scope: 'storefront', summary: 'Company RFQs', query: PageQuery, response: z.object({ items: z.array(B.Rfq), nextCursor: z.string().nullable() }), errors: [401, 403] },
  { method: 'get', path: '/v1/storefront/b2b/rfqs/{id}', scope: 'storefront', summary: 'RFQ with thread', params: IdParam, response: B.Rfq, errors: [401, 403, 404] },
  { method: 'post', path: '/v1/storefront/b2b/rfqs/{id}/messages', scope: 'storefront', summary: 'Reply in the RFQ thread', params: IdParam, body: B.RfqMessageRequest, response: B.Rfq, errors: [401, 403, 404, 409] },
  { method: 'get', path: '/v1/storefront/b2b/quotations', scope: 'storefront', summary: 'Quotations for the company', response: z.object({ items: z.array(B.BuyerQuotation) }), errors: [401, 403] },
  { method: 'post', path: '/v1/storefront/b2b/quotations/{id}/accept', scope: 'storefront', summary: 'Accept all or some quoted lines → order at the frozen price', params: IdParam, body: B.BuyerAcceptQuotationRequest, response: B.BuyerOrder, status: 201, errors: [400, 401, 403, 404, 409] },
  // ---- Phase 09: B2C retail ----
  { method: 'get', path: '/v1/storefront/catalog/products/{slug}/pieces', scope: 'storefront', summary: 'In-stock pieces of a product with actual weights (buy one exact piece)', params: C.SlugParam, response: CU.StorefrontPieceList, errors: [404] },
  { method: 'post', path: '/v1/storefront/account/register', scope: 'storefront', summary: 'Create a storefront customer account (marketing consent opt-in, recorded)', body: CU.RegisterCustomerRequest, response: CU.CustomerMe, status: 201, errors: [400, 403, 404, 409, 429] },
  { method: 'post', path: '/v1/storefront/account/login', scope: 'storefront', summary: 'Customer sign-in (sets the storefront session cookie)', body: CU.CustomerLoginRequest, response: CU.CustomerMe, errors: [400, 401, 403, 404, 423, 429] },
  { method: 'post', path: '/v1/storefront/account/logout', scope: 'storefront', summary: 'End the customer session', status: 204, errors: [403] },
  { method: 'get', path: '/v1/storefront/account/me', scope: 'storefront', summary: 'Signed-in customer, preferences and return window', response: CU.CustomerMe, errors: [401, 404] },
  { method: 'put', path: '/v1/storefront/account/profile', scope: 'storefront', summary: 'Update name/phone', body: CU.UpdateProfileRequest, response: CU.CustomerMe, errors: [400, 401, 403, 409] },
  { method: 'put', path: '/v1/storefront/account/preferences', scope: 'storefront', summary: 'Change marketing preferences (appends consent events)', body: CU.UpdatePreferencesRequest, response: CU.CustomerMe, errors: [400, 401, 403] },
  { method: 'get', path: '/v1/storefront/account/addresses', scope: 'storefront', summary: 'Saved addresses', response: z.object({ items: z.array(CU.CustomerAddress) }), errors: [401] },
  { method: 'post', path: '/v1/storefront/account/addresses', scope: 'storefront', summary: 'Save an address', body: CU.SaveAddressRequest, response: z.object({ items: z.array(CU.CustomerAddress) }), status: 201, errors: [400, 401, 403, 422] },
  { method: 'put', path: '/v1/storefront/account/addresses/{id}', scope: 'storefront', summary: 'Update a saved address', params: IdParam, body: CU.UpdateAddressRequest, response: z.object({ items: z.array(CU.CustomerAddress) }), errors: [400, 401, 403, 404, 409] },
  { method: 'delete', path: '/v1/storefront/account/addresses/{id}', scope: 'storefront', summary: 'Delete a saved address', params: IdParam, response: z.object({ items: z.array(CU.CustomerAddress) }), errors: [401, 403, 404] },
  { method: 'get', path: '/v1/storefront/account/orders', scope: 'storefront', summary: 'Orders placed by the signed-in customer', query: PageQuery, response: CU.CustomerOrderPage, errors: [401] },
  { method: 'get', path: '/v1/storefront/account/orders/{id}', scope: 'storefront', summary: 'Own order with shipments, returns, refunds, messages', params: IdParam, response: CU.CustomerOrder, errors: [401, 404] },
  { method: 'post', path: '/v1/storefront/account/orders/{id}/returns', scope: 'storefront', summary: 'Request a return of shipped items within the return window', params: IdParam, body: F.CreateReturnRequest, response: CU.CustomerOrder, status: 201, errors: [400, 401, 403, 404, 409, 422] },
  { method: 'get', path: '/v1/admin/customers', scope: 'admin', permission: 'customers.read', summary: 'Storefront customers', query: CU.CustomerListQuery, response: CU.CustomerPage },
  { method: 'get', path: '/v1/admin/customers/{id}', scope: 'admin', permission: 'customers.read', summary: 'Customer with consent history and addresses', params: IdParam, response: CU.CustomerDetail, errors: [404] },
  { method: 'put', path: '/v1/admin/customers/{id}/status', scope: 'admin', permission: 'customers.manage', summary: 'Disable (ends sessions) or re-enable a customer', params: IdParam, body: CU.UpdateCustomerStatusRequest, response: CU.CustomerDetail, errors: [400, 404, 409] },
  { method: 'post', path: '/v1/admin/orders/{id}/shipments', scope: 'admin', permission: 'fulfillment.manage', summary: 'Pack a shipment from what is left to ship (partial allowed)', params: IdParam, body: F.CreateShipmentRequest, response: O.Order, status: 201, errors: [400, 404, 409] },
  { method: 'post', path: '/v1/admin/orders/{id}/shipments/{shipmentId}/ship', scope: 'admin', permission: 'fulfillment.manage', summary: 'Dispatch: stock leaves through the ledger; carrier/tracking typed manually (not tracked)', params: z.object({ id: Uuid, shipmentId: Uuid }), body: F.ShipShipmentRequest, response: O.Order, errors: [400, 404, 409] },
  { method: 'post', path: '/v1/admin/orders/{id}/shipments/{shipmentId}/deliver', scope: 'admin', permission: 'fulfillment.manage', summary: 'Mark delivered', params: z.object({ id: Uuid, shipmentId: Uuid }), body: F.ShipmentActionRequest, response: O.Order, errors: [404, 409] },
  { method: 'post', path: '/v1/admin/orders/{id}/shipments/{shipmentId}/cancel', scope: 'admin', permission: 'fulfillment.manage', summary: 'Unpack a shipment that has not left', params: z.object({ id: Uuid, shipmentId: Uuid }), body: F.ShipmentActionRequest, response: O.Order, errors: [404, 409] },
  { method: 'post', path: '/v1/admin/orders/{id}/cancel-remaining', scope: 'admin', permission: 'orders.manage', summary: 'Cancel unshipped items after a partial shipment (exact refund due)', params: IdParam, body: F.CancelRemainingRequest, response: O.Order, errors: [400, 404, 409] },
  { method: 'post', path: '/v1/admin/orders/{id}/returns', scope: 'admin', permission: 'fulfillment.manage', summary: 'Record a return for shipped items', params: IdParam, body: F.CreateReturnRequest, response: F.OrderReturn, status: 201, errors: [400, 404, 409, 422] },
  { method: 'get', path: '/v1/admin/returns', scope: 'admin', permission: 'orders.read', summary: 'Returns', query: F.ReturnListQuery, response: F.ReturnPage },
  { method: 'post', path: '/v1/admin/returns/{id}/decide', scope: 'admin', permission: 'fulfillment.manage', summary: 'Approve or reject a return', params: IdParam, body: F.DecideReturnRequest, response: F.OrderReturn, errors: [400, 404, 409] },
  { method: 'post', path: '/v1/admin/returns/{id}/receive', scope: 'admin', permission: 'fulfillment.manage', summary: 'Receive a return: restock (ledger return_receive) or write off', params: IdParam, body: F.ReceiveReturnRequest, response: F.OrderReturn, errors: [400, 404, 409, 422] },
  { method: 'post', path: '/v1/admin/orders/{id}/refunds', scope: 'admin', permission: 'payments.refund', summary: 'Refund up to captured minus refunded; settled by the (sandbox) gateway callback', params: IdParam, body: F.CreateRefundRequest, response: O.Order, status: 201, idempotent: true, errors: [400, 403, 404, 409] },
  // ---- Phase 10: online store, discounts, marketing, reports ----
  { method: 'get', path: '/v1/admin/online-store/documents', scope: 'admin', permission: 'content.manage', summary: 'Theme, menus, banner and pages of a storefront channel', query: G.SiteQuery, response: G.SiteDocumentList, errors: [404] },
  { method: 'get', path: '/v1/admin/online-store/documents/{id}', scope: 'admin', permission: 'content.manage', summary: 'Document with draft, published content and versions', params: IdParam, response: G.SiteDocument, errors: [404] },
  { method: 'post', path: '/v1/admin/online-store/pages', scope: 'admin', permission: 'content.manage', summary: 'Create a page (draft)', body: G.CreatePageRequest, response: G.SiteDocument, status: 201, errors: [400, 404, 409] },
  { method: 'put', path: '/v1/admin/online-store/documents/{id}/draft', scope: 'admin', permission: 'content.manage', summary: 'Save draft content (validated per kind)', params: IdParam, body: G.SaveDraftRequest, response: G.SiteDocument, errors: [400, 404, 409] },
  { method: 'post', path: '/v1/admin/online-store/documents/{id}/publish', scope: 'admin', permission: 'content.manage', summary: 'Publish the draft, or an earlier version (rollback), as a new immutable version', params: IdParam, body: G.PublishRequest, response: G.SiteDocument, errors: [400, 404, 409] },
  { method: 'post', path: '/v1/admin/online-store/documents/{id}/unpublish', scope: 'admin', permission: 'content.manage', summary: 'Take a page or banner off the storefront', params: IdParam, body: G.DocumentActionRequest, response: G.SiteDocument, errors: [404, 409] },
  { method: 'post', path: '/v1/admin/online-store/preview-tokens', scope: 'admin', permission: 'content.manage', summary: 'Short-lived signed token to preview drafts on the storefront', body: G.PreviewTokenRequest, response: G.PreviewToken, status: 201, errors: [404] },
  { method: 'get', path: '/v1/admin/online-store/redirects', scope: 'admin', permission: 'content.manage', summary: 'Redirects of a storefront channel', query: G.SiteQuery, response: z.object({ items: z.array(G.Redirect) }), errors: [404] },
  { method: 'post', path: '/v1/admin/online-store/redirects', scope: 'admin', permission: 'content.manage', summary: 'Add a redirect (no chains or loops)', body: G.CreateRedirectRequest, response: G.Redirect, status: 201, errors: [400, 404, 409] },
  { method: 'delete', path: '/v1/admin/online-store/redirects/{id}', scope: 'admin', permission: 'content.manage', summary: 'Remove a redirect', params: IdParam, status: 204, errors: [404] },
  { method: 'get', path: '/v1/admin/online-store/domains', scope: 'admin', permission: 'content.manage', summary: 'Domains of a storefront channel with verification records', query: G.SiteQuery, response: z.object({ items: z.array(G.StoreDomain) }), errors: [404] },
  { method: 'post', path: '/v1/admin/online-store/domains', scope: 'admin', permission: 'content.manage', summary: 'Connect a custom domain (pending until verified by DNS TXT)', body: G.AddDomainRequest, response: G.StoreDomain, status: 201, errors: [400, 404, 409] },
  { method: 'post', path: '/v1/admin/online-store/domains/{id}/verify', scope: 'admin', permission: 'content.manage', summary: 'Check the DNS TXT record and verify the domain', params: IdParam, response: G.StoreDomain, errors: [404, 422] },
  { method: 'delete', path: '/v1/admin/online-store/domains/{id}', scope: 'admin', permission: 'content.manage', summary: 'Remove a non-primary domain', params: IdParam, status: 204, errors: [404, 409] },
  { method: 'get', path: '/v1/admin/discounts', scope: 'admin', permission: 'discounts.manage', summary: 'Discounts with derived state', query: G.DiscountListQuery, response: G.DiscountPage },
  { method: 'post', path: '/v1/admin/discounts', scope: 'admin', permission: 'discounts.manage', summary: 'Create a discount (automatic or code)', body: G.SaveDiscountRequest, response: G.Discount, status: 201, errors: [400, 409] },
  { method: 'put', path: '/v1/admin/discounts/{id}', scope: 'admin', permission: 'discounts.manage', summary: 'Update a discount (terms fixed once used)', params: IdParam, body: G.SaveDiscountRequest, response: G.Discount, errors: [400, 404, 409] },
  { method: 'get', path: '/v1/admin/marketing/segments', scope: 'admin', permission: 'marketing.manage', summary: 'Customer segments with live counts', response: z.object({ items: z.array(G.Segment) }) },
  { method: 'post', path: '/v1/admin/marketing/segments', scope: 'admin', permission: 'marketing.manage', summary: 'Create a segment', body: G.SaveSegmentRequest, response: G.Segment, status: 201, errors: [400, 409] },
  { method: 'put', path: '/v1/admin/marketing/segments/{id}', scope: 'admin', permission: 'marketing.manage', summary: 'Update a segment', params: IdParam, body: G.SaveSegmentRequest, response: G.Segment, errors: [400, 404, 409] },
  { method: 'get', path: '/v1/admin/marketing/segments/{id}/members', scope: 'admin', permission: 'marketing.manage', summary: 'Customers in a segment now', params: IdParam, query: PageQuery, response: G.SegmentMembers, errors: [404] },
  { method: 'get', path: '/v1/admin/marketing/campaigns', scope: 'admin', permission: 'marketing.manage', summary: 'Campaigns', query: PageQuery, response: G.CampaignPage },
  { method: 'post', path: '/v1/admin/marketing/campaigns', scope: 'admin', permission: 'marketing.manage', summary: 'Create a campaign draft', body: G.SaveCampaignRequest, response: G.Campaign, status: 201, errors: [400] },
  { method: 'put', path: '/v1/admin/marketing/campaigns/{id}', scope: 'admin', permission: 'marketing.manage', summary: 'Edit a draft campaign', params: IdParam, body: G.SaveCampaignRequest, response: G.Campaign, errors: [400, 404, 409] },
  { method: 'post', path: '/v1/admin/marketing/campaigns/{id}/prepare', scope: 'admin', permission: 'marketing.manage', summary: 'Snapshot consented recipients (sending is blocked: no connector)', params: IdParam, body: z.object({ version: z.number().int() }), response: G.Campaign, errors: [404, 409] },
  { method: 'get', path: '/v1/admin/marketing/campaigns/{id}/recipients', scope: 'admin', permission: 'marketing.manage', summary: 'Prepared recipients (status not_sent)', params: IdParam, query: PageQuery, response: z.object({ items: z.array(z.object({ id: Uuid, customerId: Uuid, address: z.string(), status: z.string(), statusReason: z.string().nullable() })), nextCursor: z.string().nullable() }), errors: [404] },
  { method: 'get', path: '/v1/admin/reports', scope: 'admin', permission: 'analytics.read', summary: 'Report catalogue with metric formulas', response: G.ReportList },
  { method: 'get', path: '/v1/admin/reports/{key}', scope: 'admin', permission: 'analytics.read', summary: 'Run a report (JSON or CSV), with generatedAt', params: z.object({ key: G.ReportKey }), query: G.ReportQuery, response: G.ReportResult, errors: [400] },
  { method: 'get', path: '/v1/storefront/site', scope: 'storefront', summary: 'Published theme, menus, banner and page list (drafts with a valid X-Preview-Token)', response: G.StorefrontSite, errors: [404] },
  { method: 'get', path: '/v1/storefront/pages/{slug}', scope: 'storefront', summary: 'A published page', params: z.object({ slug: G.PageSlug }), response: G.StorefrontPage, errors: [404] },
  { method: 'get', path: '/v1/storefront/redirects', scope: 'storefront', summary: 'Where an old path now lives', query: G.RedirectQuery, response: G.RedirectLookup, errors: [404] },
  { method: 'put', path: '/v1/storefront/carts/{id}/discount', scope: 'storefront', summary: 'Enter or clear a discount code; the cart is re-priced and says why a code does not apply', params: IdParam, body: G.ApplyDiscountCodeRequest, response: O.Cart, errors: [404, 409] },
  // ---- Phase 11: operations ----
  { method: 'post', path: '/v1/auth/mfa/verify', scope: 'auth', summary: 'Second step of sign-in: challenge token + TOTP or recovery code', body: OP.MfaVerifyRequest, response: A.MeResponse, errors: [400, 401] },
  { method: 'get', path: '/v1/auth/mfa', scope: 'auth', summary: 'Two-step verification status of the signed-in staff member', response: OP.MfaStatus, errors: [401] },
  { method: 'post', path: '/v1/auth/mfa/enroll', scope: 'auth', summary: 'Start enrolment (secret + otpauth URI)', response: OP.MfaEnrollment, errors: [401, 409] },
  { method: 'post', path: '/v1/auth/mfa/confirm', scope: 'auth', summary: 'Confirm enrolment with a code; returns recovery codes once', body: OP.MfaConfirmRequest, response: OP.MfaRecoveryCodes, errors: [401, 409, 422] },
  { method: 'post', path: '/v1/auth/mfa/disable', scope: 'auth', summary: 'Turn off with password + code', body: OP.MfaDisableRequest, status: 204, errors: [401, 422] },
  { method: 'get', path: '/v1/admin/webhooks', scope: 'admin', permission: 'webhooks.manage', summary: 'Webhook endpoints', response: z.object({ items: z.array(OP.WebhookEndpoint) }) },
  { method: 'post', path: '/v1/admin/webhooks', scope: 'admin', permission: 'webhooks.manage', summary: 'Add an endpoint (signing secret returned once; private addresses refused)', body: OP.SaveWebhookEndpointRequest, response: OP.WebhookSecretResponse, status: 201, errors: [400, 422] },
  { method: 'put', path: '/v1/admin/webhooks/{id}', scope: 'admin', permission: 'webhooks.manage', summary: 'Update an endpoint', params: IdParam, body: OP.SaveWebhookEndpointRequest, response: OP.WebhookEndpoint, errors: [400, 404, 409, 422] },
  { method: 'post', path: '/v1/admin/webhooks/{id}/rotate-secret', scope: 'admin', permission: 'webhooks.manage', summary: 'New signing secret (returned once); the old one stops working', params: IdParam, response: OP.WebhookSecretResponse, errors: [404] },
  { method: 'delete', path: '/v1/admin/webhooks/{id}', scope: 'admin', permission: 'webhooks.manage', summary: 'Remove an endpoint', params: IdParam, status: 204, errors: [404] },
  { method: 'post', path: '/v1/admin/webhooks/{id}/test', scope: 'admin', permission: 'webhooks.manage', summary: 'Queue a signed test (Ping) delivery', params: IdParam, response: z.object({ deliveryId: Uuid }), status: 202, errors: [404] },
  { method: 'get', path: '/v1/admin/webhooks/{id}/deliveries', scope: 'admin', permission: 'webhooks.manage', summary: 'Deliveries with attempts and last error', params: IdParam, query: OP.WebhookDeliveryQuery, response: OP.WebhookDeliveryPage, errors: [404] },
  { method: 'post', path: '/v1/admin/webhook-deliveries/{id}/replay', scope: 'admin', permission: 'webhooks.manage', summary: 'Re-queue a failed or dead delivery', params: IdParam, response: z.object({ status: z.literal('pending') }), errors: [404, 409] },
  { method: 'get', path: '/v1/admin/automations', scope: 'admin', permission: 'integrations.manage', summary: 'Automations with run counts', response: z.object({ items: z.array(OP.Automation) }) },
  { method: 'post', path: '/v1/admin/automations', scope: 'admin', permission: 'integrations.manage', summary: 'Create an automation (typed trigger, conditions, action)', body: OP.SaveAutomationRequest, response: OP.Automation, status: 201, errors: [400] },
  { method: 'put', path: '/v1/admin/automations/{id}', scope: 'admin', permission: 'integrations.manage', summary: 'Update or pause an automation', params: IdParam, body: OP.SaveAutomationRequest, response: OP.Automation, errors: [400, 404, 409] },
  { method: 'get', path: '/v1/admin/automations/{id}/runs', scope: 'admin', permission: 'integrations.manage', summary: 'Latest runs', params: IdParam, response: z.object({ items: z.array(OP.AutomationRun) }), errors: [404] },
  { method: 'get', path: '/v1/admin/notifications', scope: 'admin', summary: 'Staff inbox', response: OP.StaffNotificationList },
  { method: 'post', path: '/v1/admin/notifications/read', scope: 'admin', summary: 'Mark notifications read', body: z.object({ ids: z.array(Uuid) }), response: OP.StaffNotificationList },
  { method: 'get', path: '/v1/admin/api-keys', scope: 'admin', permission: 'apikeys.manage', summary: 'API keys (never the secret)', response: z.object({ items: z.array(OP.ApiKey) }) },
  { method: 'post', path: '/v1/admin/api-keys', scope: 'admin', permission: 'apikeys.manage', summary: 'Create a read-only key (shown once)', body: OP.CreateApiKeyRequest, response: OP.CreatedApiKey, status: 201, errors: [400] },
  { method: 'post', path: '/v1/admin/api-keys/{id}/revoke', scope: 'admin', permission: 'apikeys.manage', summary: 'Revoke a key', params: IdParam, response: OP.ApiKey, errors: [404] },
  { method: 'get', path: '/v1/admin/operations/health', scope: 'admin', permission: 'operations.read', summary: 'Operations health checks with thresholds', response: OP.OpsHealth },
  { method: 'get', path: '/v1/admin/operations/providers', scope: 'admin', permission: 'integrations.read', summary: 'Payment/shipping/notification providers and their real status', response: OP.ProviderList },
  { method: 'get', path: '/v1/admin/security', scope: 'admin', permission: 'settings.read', summary: 'Merchant security settings', response: OP.MfaSettingRequest },
  { method: 'put', path: '/v1/admin/security', scope: 'admin', permission: 'settings.manage', summary: 'Require two-step verification for owners and admins', body: OP.MfaSettingRequest, response: OP.MfaSettingRequest, errors: [409] },
  { method: 'get', path: '/v1/admin/orders-export.csv', scope: 'admin', permission: 'orders.read', summary: 'Orders as CSV (list filters, up to 10 000 rows)', query: O.OrderListQuery.omit({ cursor: true, limit: true }) },
  { method: 'get', path: '/v1/platform/operations/health', scope: 'platform', permission: 'platform.tenants.read', summary: 'Platform-wide operations health', response: OP.OpsHealth },
  { method: 'get', path: '/v1/platform/operations/dead-events', scope: 'platform', permission: 'platform.tenants.read', summary: 'Events that failed to publish', response: OP.DeadEventList },
  { method: 'post', path: '/v1/platform/operations/dead-events/{id}/replay', scope: 'platform', permission: 'platform.tenants.manage', summary: 'Re-queue a dead event (consumers dedupe by id)', params: IdParam, response: z.object({ status: z.literal('pending') }), errors: [404] },
];
const SECURITY: Record<Scope, RouteConfig['security']> = {
  auth: [],
  system: [],
  storefront: [],
  admin: [{ merchantSession: [], tenantHeader: [] }],
  platform: [{ platformSession: [] }],
};

export function buildOpenApiDocument(
  serverUrl = 'http://localhost:4100',
): ReturnType<OpenApiGeneratorV31['generateDocument']> {
  const registry = new OpenAPIRegistry();
  registry.register('Error', ErrorBody);
  registry.registerComponent('securitySchemes', 'merchantSession', { type: 'apiKey', in: 'cookie', name: 'uc_m_sess' });
  registry.registerComponent('securitySchemes', 'platformSession', { type: 'apiKey', in: 'cookie', name: 'uc_p_sess' });
  registry.registerComponent('securitySchemes', 'tenantHeader', {
    type: 'apiKey',
    in: 'header',
    name: 'X-Tenant-Id',
    description: 'Tenant UUID; validated against an active membership on every request',
  });

  for (const route of API_ROUTES) {
    const responses: RouteConfig['responses'] = {};
    const status = route.status ?? 200;
    responses[status] = route.binary
      ? { description: 'Image bytes', content: { 'image/*': { schema: z.string().openapi({ format: 'binary' }) } } }
      : route.csv
        ? { description: 'CSV file', content: { 'text/csv': { schema: z.string() } } }
        : route.response
        ? json(route.response)
        : { description: 'No content' };
    const errors = new Set<number>([...(route.errors ?? []), 500]);
    if (route.scope === 'admin' || route.scope === 'platform') [401, 403].forEach((c) => errors.add(c));
    for (const code of errors) responses[code] = json(ErrorBody, 'Error');

    const headerShape: Record<string, z.ZodTypeAny> = {};
    if (route.idempotent) headerShape['idempotency-key'] = z.string().min(8).max(128);
    if (route.method !== 'get' && (route.scope === 'admin' || route.scope === 'platform' || route.path.startsWith('/v1/auth/')))
      headerShape['x-uc-csrf'] = z.literal('1');

    registry.registerPath({
      method: route.method,
      path: route.path,
      tags: [route.scope],
      summary: route.summary,
      description: route.permission ? `Requires permission \`${route.permission}\`.` : undefined,
      security: SECURITY[route.scope],
      request: {
        params: route.params,
        query: route.query,
        headers: Object.keys(headerShape).length ? z.object(headerShape) : undefined,
        body: route.multipart
          ? { content: { 'multipart/form-data': { schema: z.object({ file: z.string().openapi({ format: 'binary' }) }) } } }
          : route.body
            ? { content: { 'application/json': { schema: route.body } } }
            : undefined,
      },
      responses,
    });
  }

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Universal Commerce OS API',
      version: '1.0.0-phase11',
      description:
        'Multi-tenant commerce platform API. Errors use {code,message,details,correlationId}. Decimals are strings; money is {amountMinor,currency}.',
    },
    servers: [{ url: serverUrl }],
  });
}
