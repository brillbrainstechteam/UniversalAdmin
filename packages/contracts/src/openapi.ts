import { OpenAPIRegistry, OpenApiGeneratorV31, type RouteConfig } from '@asteasolutions/zod-to-openapi';
import { IdParam } from './common';
import { ErrorBody } from './errors';
import { z } from './z';
import * as A from './dto/auth';
import * as T from './dto/tenant';
import * as M from './dto/admin';
import * as S from './dto/storefront';

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
    responses[status] = route.response ? json(route.response) : { description: 'No content' };
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
        body: route.body ? { content: { 'application/json': { schema: route.body } } } : undefined,
      },
      responses,
    });
  }

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Universal Commerce OS API',
      version: '1.0.0-phase01',
      description:
        'Multi-tenant commerce platform API. Errors use {code,message,details,correlationId}. Decimals are strings; money is {amountMinor,currency}.',
    },
    servers: [{ url: serverUrl }],
  });
}
