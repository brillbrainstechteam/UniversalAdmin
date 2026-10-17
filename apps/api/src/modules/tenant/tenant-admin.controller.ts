import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { AuditQuery, UpdateTenantSettingsRequest } from '@uc/contracts';
import { AnyMember, Auth, Meta, RequirePermission, Tenant } from '../../common/decorators';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { zod } from '../../common/zod.pipe';
import { AdminRoute } from '../access/guards';
import { AuditQueryService } from '../audit/audit-query.service';
import { TenantAdminService } from './tenant-admin.service';

@Controller('v1/admin')
@AdminRoute()
export class TenantAdminController {
  constructor(
    private readonly service: TenantAdminService,
    private readonly audit: AuditQueryService,
  ) {}

  @Get('context')
  @AnyMember()
  context(@Auth() auth: AuthState, @Tenant() ctx: TenantState) {
    return this.service.context(auth, ctx);
  }

  @Get('home')
  @AnyMember()
  home(@Tenant() ctx: TenantState) {
    return this.service.home(ctx);
  }

  @Get('settings/general')
  @RequirePermission('settings.read')
  getSettings(@Tenant() ctx: TenantState) {
    return this.service.getSettings(ctx);
  }

  @Patch('settings/general')
  @RequirePermission('settings.manage')
  updateSettings(
    @Auth() auth: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(UpdateTenantSettingsRequest)) body: UpdateTenantSettingsRequest,
    @Meta() meta: RequestMeta,
  ) {
    return this.service.updateSettings(auth, ctx, body, meta);
  }

  @Get('audit-events')
  @RequirePermission('audit.read')
  auditEvents(@Tenant() ctx: TenantState, @Query(zod(AuditQuery)) query: AuditQuery) {
    return this.audit.forTenant(ctx.tenantId, query);
  }
}
