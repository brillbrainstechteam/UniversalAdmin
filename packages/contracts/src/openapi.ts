import { OpenAPIRegistry, OpenApiGeneratorV31, type RouteConfig } from '@asteasolutions/zod-to-openapi';
import { IdParam } from './common';
import { ErrorBody } from './errors';
import { z } from './z';
import * as A from './dto/auth';
import * as T from './dto/tenant';
import * as M from './dto/admin';
import * as S from './dto/storefront';
import * as C from './dto/catalog';
import * as J from './dto/jewellery';
import * as I from './dto/inventory';

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
  status?: 200 | 201 | 204;
  errors?: number[];
  /** multipart/form-data upload with a single "file" field. */
  multipart?: boolean;
  /** Response is raw bytes (image). */
  binary?: boolean;
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
      version: '1.0.0-phase03',
      description:
        'Multi-tenant commerce platform API. Errors use {code,message,details,correlationId}. Decimals are strings; money is {amountMinor,currency}.',
    },
    servers: [{ url: serverUrl }],
  });
}
