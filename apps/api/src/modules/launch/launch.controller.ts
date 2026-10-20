import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import {
  AssignPlanRequest,
  DecideSupportGrant,
  IdParam,
  PlanKey,
  RequestSupportAccess,
  SavePlanRequest,
  Uuid,
  z,
} from '@uc/contracts';
import type { Response } from 'express';
import {
  AnyMember,
  Auth,
  Meta,
  RequirePermission,
  RequirePlatformPermission,
  Tenant,
} from '../../common/decorators';
import { AppError } from '../../common/errors';
import type { AppRequest, AuthState, RequestMeta, TenantState } from '../../common/request';
import { zod } from '../../common/zod.pipe';
import { RedisService } from '../../db/redis.service';
import { AdminRoute, PlatformRoute } from '../access/guards';
import { SessionService } from '../auth/session.service';
import { ChecklistsService } from './checklists.service';
import { PlansService } from './plans.service';
import { SupportService } from './support.service';

type Id = z.infer<typeof IdParam>;
const KeyParam = z.object({ key: PlanKey });
const GrantListQuery = z.object({ tenantId: Uuid.optional() });
const RedeemRequest = z.object({ code: z.string().min(20).max(200) });

/** Phase 12 merchant admin: plan & usage, setup checklist, support access approvals, pilot checklist (ADR-027). */
@Controller('v1/admin')
@AdminRoute()
export class LaunchAdminController {
  constructor(
    private readonly plans: PlansService,
    private readonly checklists: ChecklistsService,
    private readonly support: SupportService,
  ) {}

  @Get('plan')
  @AnyMember()
  plan(@Tenant() ctx: TenantState) {
    return this.plans.usage(ctx.tenantId);
  }

  @Get('setup')
  @AnyMember()
  setup(@Tenant() ctx: TenantState) {
    return this.checklists.setup(ctx);
  }

  @Get('integrations/connections/:id/pilot-checklist')
  @RequirePermission('integrations.read')
  pilot(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.checklists.pilot(ctx, p.id);
  }

  @Get('support-grants')
  @RequirePermission('support.manage')
  grants(@Tenant() ctx: TenantState) {
    return this.support.listTenant(ctx);
  }

  @Post('support-grants/:id/approve')
  @HttpCode(200)
  @RequirePermission('support.manage')
  approve(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(DecideSupportGrant)) body: DecideSupportGrant,
    @Meta() m: RequestMeta,
  ) {
    return this.support.approve(a, ctx, p.id, body, m);
  }

  @Post('support-grants/:id/deny')
  @HttpCode(200)
  @RequirePermission('support.manage')
  deny(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(DecideSupportGrant)) body: DecideSupportGrant,
    @Meta() m: RequestMeta,
  ) {
    return this.support.deny(a, ctx, p.id, body, m);
  }

  @Post('support-grants/:id/revoke')
  @HttpCode(200)
  @RequirePermission('support.manage')
  revoke(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Meta() m: RequestMeta,
  ) {
    return this.support.revokeByMerchant(a, ctx, p.id, m);
  }
}

/** Phase 12 platform: plans, tenant plan/usage, support access requests. */
@Controller('v1/platform')
@PlatformRoute()
export class PlatformLaunchController {
  constructor(
    private readonly plans: PlansService,
    private readonly support: SupportService,
  ) {}

  @Get('plans')
  @RequirePlatformPermission('platform.tenants.read')
  listPlans() {
    return this.plans.list();
  }

  @Put('plans/:key')
  @RequirePlatformPermission('platform.plans.manage')
  savePlan(
    @Auth() a: AuthState,
    @Param(zod(KeyParam)) p: z.infer<typeof KeyParam>,
    @Body(zod(SavePlanRequest)) body: SavePlanRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.plans.save(a, p.key, body, m);
  }

  @Get('tenants/:id/usage')
  @RequirePlatformPermission('platform.tenants.read')
  usage(@Param(zod(IdParam)) p: Id) {
    return this.plans.usage(p.id);
  }

  @Put('tenants/:id/plan')
  @RequirePlatformPermission('platform.plans.manage')
  assign(
    @Auth() a: AuthState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(AssignPlanRequest)) body: AssignPlanRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.plans.assign(a, p.id, body, m);
  }

  @Get('support-grants')
  @RequirePlatformPermission('platform.support.request')
  grants(@Query(zod(GrantListQuery)) q: z.infer<typeof GrantListQuery>) {
    return this.support.listPlatform(q.tenantId);
  }

  @Post('tenants/:id/support-grants')
  @RequirePlatformPermission('platform.support.request')
  request(
    @Auth() a: AuthState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(RequestSupportAccess)) body: RequestSupportAccess,
    @Meta() m: RequestMeta,
  ) {
    return this.support.request(a, p.id, body, m);
  }

  @Post('support-grants/:id/start')
  @HttpCode(200)
  @RequirePlatformPermission('platform.support.request')
  start(@Auth() a: AuthState, @Param(zod(IdParam)) p: Id, @Meta() m: RequestMeta) {
    return this.support.start(a, p.id, m);
  }

  @Post('support-grants/:id/revoke')
  @HttpCode(200)
  @RequirePlatformPermission('platform.support.request')
  revoke(@Auth() a: AuthState, @Param(zod(IdParam)) p: Id, @Meta() m: RequestMeta) {
    return this.support.revokeByOperator(a, p.id, m);
  }
}

/** Merchant admin redeems the one-time support handoff code on its own origin (sets the merchant cookie). */
@Controller('v1/auth')
export class SupportAuthController {
  constructor(
    private readonly support: SupportService,
    private readonly sessions: SessionService,
    private readonly redis: RedisService,
  ) {}

  @Post('support/redeem')
  @HttpCode(200)
  async redeem(
    @Req() req: AppRequest,
    @Body(zod(RedeemRequest)) body: z.infer<typeof RedeemRequest>,
    @Meta() m: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!(await this.redis.hit(`rl:support-redeem:${req.ip ?? 'unknown'}`, 20, 60)))
      throw new AppError(429, 'RATE_LIMITED', 'Too many attempts. Try again in a minute.');
    const { token, tenantId, expiresAt } = await this.support.redeem(body.code, m);
    this.sessions.setCookie(res, 'merchant', token);
    return { tenantId, expiresAt: expiresAt.toISOString() };
  }
}
