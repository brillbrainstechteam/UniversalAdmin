import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import {
  CreateInvitationRequest,
  CreateRoleRequest,
  IdParam,
  InvitationListQuery,
  MemberListQuery,
  UpdateMemberRequest,
  UpdateRoleRequest,
  type z,
} from '@uc/contracts';
import type { Response } from 'express';
import { Auth, Meta, RequirePermission, Tenant } from '../../common/decorators';
import { IdempotencyService } from '../../common/idempotency.service';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { zod } from '../../common/zod.pipe';
import { AdminRoute } from '../access/guards';
import { StaffService } from './staff.service';

type Id = z.infer<typeof IdParam>;

@Controller('v1/admin')
@AdminRoute()
export class StaffController {
  constructor(
    private readonly service: StaffService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('members')
  @RequirePermission('staff.read')
  listMembers(@Tenant() ctx: TenantState, @Query(zod(MemberListQuery)) query: MemberListQuery) {
    return this.service.listMembers(ctx, query);
  }

  @Patch('members/:id')
  @RequirePermission('staff.manage')
  updateMember(
    @Auth() auth: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) params: Id,
    @Body(zod(UpdateMemberRequest)) body: UpdateMemberRequest,
    @Meta() meta: RequestMeta,
  ) {
    return this.service.updateMember(auth, ctx, params.id, body, meta);
  }

  @Get('invitations')
  @RequirePermission('staff.read')
  listInvitations(
    @Tenant() ctx: TenantState,
    @Query(zod(InvitationListQuery)) query: z.infer<typeof InvitationListQuery>,
  ) {
    return this.service.listInvitations(ctx, query);
  }

  @Post('invitations')
  @RequirePermission('staff.manage')
  async createInvitation(
    @Auth() auth: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateInvitationRequest)) body: CreateInvitationRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.idempotency.run(
      {
        scope: `tenant:${ctx.tenantId}:user:${auth.userId}`,
        key,
        route: 'POST /v1/admin/invitations',
        request: body,
      },
      async () => ({ status: 201, body: await this.service.createInvitation(auth, ctx, body, meta) }),
    );
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Post('invitations/:id/revoke')
  @HttpCode(200)
  @RequirePermission('staff.manage')
  revokeInvitation(
    @Auth() auth: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) params: Id,
    @Meta() meta: RequestMeta,
  ) {
    return this.service.revokeInvitation(auth, ctx, params.id, meta);
  }

  @Get('roles')
  @RequirePermission('roles.read')
  listRoles(@Tenant() ctx: TenantState) {
    return this.service.listRoles(ctx);
  }

  @Post('roles')
  @RequirePermission('roles.manage')
  createRole(
    @Auth() auth: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateRoleRequest)) body: CreateRoleRequest,
    @Meta() meta: RequestMeta,
  ) {
    return this.service.createRole(auth, ctx, body, meta);
  }

  @Patch('roles/:id')
  @RequirePermission('roles.manage')
  updateRole(
    @Auth() auth: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) params: Id,
    @Body(zod(UpdateRoleRequest)) body: UpdateRoleRequest,
    @Meta() meta: RequestMeta,
  ) {
    return this.service.updateRole(auth, ctx, params.id, body, meta);
  }

  @Get('permissions')
  @RequirePermission('roles.read')
  permissions() {
    return this.service.permissionCatalog();
  }
}
