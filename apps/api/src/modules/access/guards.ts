import {
  applyDecorators,
  Inject,
  Injectable,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Audience, PlatformPermission, TenantPermission } from '@uc/contracts';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { ANY_MEMBER_KEY, PERMISSION_KEY, PLATFORM_PERMISSION_KEY } from '../../common/decorators';
import { AppError, Errors } from '../../common/errors';
import type { AppRequest } from '../../common/request';
import { SessionService } from '../auth/session.service';
import { AccessService } from './access.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global CSRF defence for cookie-authenticated APIs (ADR-003): mutations must carry `X-UC-CSRF: 1` (cannot be set
 * cross-site without a CORS preflight, which we never allow) and, when present, an allow-listed Origin.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AppRequest>();
    if (SAFE_METHODS.has(req.method)) return true;
    if (!/^\/v1\/(auth|admin|platform)\//.test(req.path)) return true;
    const origin = req.header('origin');
    if (origin && !this.config.ALLOWED_ORIGINS.includes(origin)) {
      throw new AppError(403, 'CSRF_CHECK_FAILED', 'Origin not allowed');
    }
    if (req.header('x-uc-csrf') !== '1') {
      throw new AppError(403, 'CSRF_CHECK_FAILED', 'Missing X-UC-CSRF header');
    }
    return true;
  }
}

abstract class SessionGuard implements CanActivate {
  protected abstract readonly audience: Audience;
  constructor(protected readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const auth = await this.sessions.resolve(this.sessions.tokenFrom(req, this.audience), this.audience);
    if (!auth) throw Errors.unauthenticated('Your session has expired. Please sign in again.');
    req.auth = auth;
    return true;
  }
}

@Injectable()
export class MerchantSessionGuard extends SessionGuard {
  protected readonly audience = 'merchant' as const;
  constructor(sessions: SessionService) {
    super(sessions);
  }
}

@Injectable()
export class PlatformSessionGuard extends SessionGuard {
  protected readonly audience = 'platform' as const;
  constructor(sessions: SessionService) {
    super(sessions);
  }
}

/** Resolves X-Tenant-Id against an active membership of the authenticated user on every request. */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly access: AccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>();
    if (!req.auth) throw Errors.unauthenticated();
    const tenantId = req.header('x-tenant-id');
    if (!tenantId) throw new AppError(400, 'TENANT_REQUIRED', 'X-Tenant-Id header is required');
    if (!UUID_RE.test(tenantId)) throw new AppError(400, 'TENANT_REQUIRED', 'X-Tenant-Id must be a UUID');
    req.tenant = await this.access.resolveTenant(req.auth.userId, tenantId.toLowerCase());
    return true;
  }
}

/** Enforces @RequirePermission / @AnyMember. A handler with neither is rejected (fail closed). */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(ANY_MEMBER_KEY, targets)) return true;
    const permission = this.reflector.getAllAndOverride<TenantPermission | undefined>(
      PERMISSION_KEY,
      targets,
    );
    if (!permission) throw Errors.forbidden('Route has no permission policy');
    if (!req.tenant?.permissions.has(permission)) throw Errors.permission(permission);
    return true;
  }
}

@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>();
    if (!req.auth) throw Errors.unauthenticated();
    const platform = await this.access.resolvePlatform(req.auth.userId);
    if (!platform) throw Errors.forbidden('Platform operator access required');
    const permission = this.reflector.getAllAndOverride<PlatformPermission | undefined>(
      PLATFORM_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!permission) throw Errors.forbidden('Route has no permission policy');
    if (!platform.permissions.has(permission)) throw Errors.permission(permission);
    req.platform = platform;
    return true;
  }
}

/** Merchant admin API: session (merchant audience) → tenant membership → permission. */
export const AdminRoute = () =>
  applyDecorators(UseGuards(MerchantSessionGuard, TenantGuard, PermissionGuard));
/** Platform API: session (platform audience) → platform role → platform permission. */
export const PlatformRoute = () => applyDecorators(UseGuards(PlatformSessionGuard, PlatformGuard));
