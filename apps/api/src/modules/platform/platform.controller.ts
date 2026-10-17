import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import {
  CreateTenantRequest,
  IdParam,
  PlatformAuditQuery,
  TenantListQuery,
  TenantStatusChangeRequest,
  UpdateEntitlementsRequest,
  UpdateTenantRequest,
  type z,
} from '@uc/contracts';
import type { Response } from 'express';
import { Auth, Meta, RequirePlatformPermission } from '../../common/decorators';
import { IdempotencyService } from '../../common/idempotency.service';
import type { AuthState, RequestMeta } from '../../common/request';
import { zod } from '../../common/zod.pipe';
import { PlatformRoute } from '../access/guards';
import { AuditQueryService } from '../audit/audit-query.service';
import { PlatformTenantsService } from './platform-tenants.service';

type Id = z.infer<typeof IdParam>;

@Controller('v1/platform')
@PlatformRoute()
export class PlatformController {
  constructor(
    private readonly tenants: PlatformTenantsService,
    private readonly audit: AuditQueryService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('presets')
  @RequirePlatformPermission('platform.tenants.read')
  presets() {
    return this.tenants.presets();
  }

  @Get('tenants')
  @RequirePlatformPermission('platform.tenants.read')
  list(@Query(zod(TenantListQuery)) query: TenantListQuery) {
    return this.tenants.list(query);
  }

  @Post('tenants')
  @RequirePlatformPermission('platform.tenants.manage')
  async create(
    @Auth() auth: AuthState,
    @Body(zod(CreateTenantRequest)) body: CreateTenantRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.idempotency.run(
      { scope: `platform:${auth.userId}`, key, route: 'POST /v1/platform/tenants', request: body },
      async () => ({ status: 201, body: await this.tenants.create(auth, body, meta) }),
    );
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Get('tenants/:id')
  @RequirePlatformPermission('platform.tenants.read')
  get(@Param(zod(IdParam)) params: Id) {
    return this.tenants.get(params.id);
  }

  @Patch('tenants/:id')
  @RequirePlatformPermission('platform.tenants.manage')
  update(
    @Auth() auth: AuthState,
    @Param(zod(IdParam)) params: Id,
    @Body(zod(UpdateTenantRequest)) body: UpdateTenantRequest,
    @Meta() meta: RequestMeta,
  ) {
    return this.tenants.update(auth, params.id, body, meta);
  }

  @Post('tenants/:id/suspend')
  @HttpCode(200)
  @RequirePlatformPermission('platform.tenants.manage')
  suspend(
    @Auth() auth: AuthState,
    @Param(zod(IdParam)) params: Id,
    @Body(zod(TenantStatusChangeRequest)) body: TenantStatusChangeRequest,
    @Meta() meta: RequestMeta,
  ) {
    return this.tenants.changeStatus(auth, params.id, 'suspended', body, meta);
  }

  @Post('tenants/:id/reactivate')
  @HttpCode(200)
  @RequirePlatformPermission('platform.tenants.manage')
  reactivate(
    @Auth() auth: AuthState,
    @Param(zod(IdParam)) params: Id,
    @Body(zod(TenantStatusChangeRequest)) body: TenantStatusChangeRequest,
    @Meta() meta: RequestMeta,
  ) {
    return this.tenants.changeStatus(auth, params.id, 'active', body, meta);
  }

  @Get('tenants/:id/entitlements')
  @RequirePlatformPermission('platform.tenants.read')
  entitlements(@Param(zod(IdParam)) params: Id) {
    return this.tenants.getEntitlements(params.id);
  }

  @Put('tenants/:id/entitlements')
  @RequirePlatformPermission('platform.entitlements.manage')
  updateEntitlements(
    @Auth() auth: AuthState,
    @Param(zod(IdParam)) params: Id,
    @Body(zod(UpdateEntitlementsRequest)) body: UpdateEntitlementsRequest,
    @Meta() meta: RequestMeta,
  ) {
    return this.tenants.updateEntitlements(auth, params.id, body, meta);
  }

  @Get('audit-events')
  @RequirePlatformPermission('platform.audit.read')
  auditEvents(@Query(zod(PlatformAuditQuery)) query: PlatformAuditQuery) {
    return this.audit.forPlatform(query);
  }
}
