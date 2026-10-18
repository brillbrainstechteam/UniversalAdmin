import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { PlatformPermission, TenantPermission } from '@uc/contracts';
import { Errors } from './errors';
import {
  metaOf,
  type AppRequest,
  type AuthState,
  type PlatformState,
  type RequestMeta,
  type TenantState,
} from './request';

export const PERMISSION_KEY = 'uc:permission';
export const ANY_MEMBER_KEY = 'uc:any-member';
export const PLATFORM_PERMISSION_KEY = 'uc:platform-permission';
export const TENANT_QUERY_KEY = 'uc:tenant-query';

/** GET route may receive the tenant id as ?tenantId= (for <img src>); membership is still enforced. */
export const AllowTenantQuery = () => SetMetadata(TENANT_QUERY_KEY, true);

/** Handler requires this tenant permission (checked server-side by PermissionGuard). */
export const RequirePermission = (permission: TenantPermission) => SetMetadata(PERMISSION_KEY, permission);
/** Handler is available to every active member (explicit opt-in; guards fail closed otherwise). */
export const AnyMember = () => SetMetadata(ANY_MEMBER_KEY, true);
export const RequirePlatformPermission = (permission: PlatformPermission) =>
  SetMetadata(PLATFORM_PERMISSION_KEY, permission);

const req = (ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AppRequest>();

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthState => {
  const auth = req(ctx).auth;
  if (!auth) throw Errors.unauthenticated();
  return auth;
});

export const Tenant = createParamDecorator((_: unknown, ctx: ExecutionContext): TenantState => {
  const tenant = req(ctx).tenant;
  if (!tenant) throw Errors.forbidden('Tenant context missing');
  return tenant;
});

export const Platform = createParamDecorator((_: unknown, ctx: ExecutionContext): PlatformState => {
  const platform = req(ctx).platform;
  if (!platform) throw Errors.forbidden('Platform context missing');
  return platform;
});

export const Meta = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestMeta =>
  metaOf(req(ctx)),
);
