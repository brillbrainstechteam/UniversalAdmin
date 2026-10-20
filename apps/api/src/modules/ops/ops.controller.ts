import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import {
  CreateApiKeyRequest,
  IdParam,
  MfaSettingRequest,
  OrderListQuery,
  PROVIDERS,
  SaveAutomationRequest,
  SaveWebhookEndpointRequest,
  WebhookDeliveryQuery,
  Uuid,
  z,
} from '@uc/contracts';
import { mfaFactors, tenants, writeAudit } from '@uc/db';
import { eq } from 'drizzle-orm';
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
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { zod } from '../../common/zod.pipe';
import { DbService } from '../../db/db.service';
import { AdminRoute, PlatformRoute } from '../access/guards';
import { ApiKeysService } from './api-keys.service';
import { OpsService } from './ops.service';
import { WebhooksService } from './webhooks.service';

type Id = z.infer<typeof IdParam>;
const ReadRequest = z.object({ ids: z.array(Uuid).min(1).max(100) });
const OrdersExportQuery = OrderListQuery.omit({ cursor: true, limit: true });

/** Phase 11 merchant operations API (ADR-026). */
@Controller('v1/admin')
@AdminRoute()
export class OpsController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly keys: ApiKeysService,
    private readonly ops: OpsService,
    private readonly db: DbService,
  ) {}

  // ---- webhooks
  @Get('webhooks')
  @RequirePermission('webhooks.manage')
  listWebhooks(@Tenant() ctx: TenantState) {
    return this.webhooks.list(ctx);
  }

  @Post('webhooks')
  @RequirePermission('webhooks.manage')
  createWebhook(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(SaveWebhookEndpointRequest)) body: SaveWebhookEndpointRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.webhooks.create(a, ctx, body, m);
  }

  @Put('webhooks/:id')
  @RequirePermission('webhooks.manage')
  updateWebhook(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(SaveWebhookEndpointRequest)) body: SaveWebhookEndpointRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.webhooks.update(a, ctx, p.id, body, m);
  }

  @Post('webhooks/:id/rotate-secret')
  @HttpCode(200)
  @RequirePermission('webhooks.manage')
  rotate(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Meta() m: RequestMeta,
  ) {
    return this.webhooks.rotate(a, ctx, p.id, m);
  }

  @Delete('webhooks/:id')
  @HttpCode(204)
  @RequirePermission('webhooks.manage')
  async removeWebhook(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Meta() m: RequestMeta,
  ) {
    await this.webhooks.remove(a, ctx, p.id, m);
  }

  @Post('webhooks/:id/test')
  @HttpCode(202)
  @RequirePermission('webhooks.manage')
  testWebhook(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.webhooks.test(ctx, p.id);
  }

  @Get('webhooks/:id/deliveries')
  @RequirePermission('webhooks.manage')
  deliveries(
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Query(zod(WebhookDeliveryQuery)) q: WebhookDeliveryQuery,
  ) {
    return this.webhooks.deliveries(ctx, p.id, q);
  }

  @Post('webhook-deliveries/:id/replay')
  @HttpCode(200)
  @RequirePermission('webhooks.manage')
  replay(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Meta() m: RequestMeta,
  ) {
    return this.webhooks.replay(a, ctx, p.id, m);
  }

  // ---- automations
  @Get('automations')
  @RequirePermission('integrations.manage')
  automations(@Tenant() ctx: TenantState) {
    return this.ops.automations(ctx);
  }

  @Post('automations')
  @RequirePermission('integrations.manage')
  createAutomation(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(SaveAutomationRequest)) body: SaveAutomationRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.ops.saveAutomation(a, ctx, null, body, m);
  }

  @Put('automations/:id')
  @RequirePermission('integrations.manage')
  updateAutomation(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(SaveAutomationRequest)) body: SaveAutomationRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.ops.saveAutomation(a, ctx, p.id, body, m);
  }

  @Get('automations/:id/runs')
  @RequirePermission('integrations.manage')
  runs(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.ops.runs(ctx, p.id);
  }

  // ---- staff inbox
  @Get('notifications')
  @AnyMember()
  notifications(@Auth() a: AuthState, @Tenant() ctx: TenantState) {
    return this.ops.notifications(a, ctx);
  }

  @Post('notifications/read')
  @HttpCode(200)
  @AnyMember()
  markRead(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(ReadRequest)) body: z.infer<typeof ReadRequest>,
  ) {
    return this.ops.markRead(a, ctx, body.ids);
  }

  // ---- API keys
  @Get('api-keys')
  @RequirePermission('apikeys.manage')
  listKeys(@Tenant() ctx: TenantState) {
    return this.keys.list(ctx);
  }

  @Post('api-keys')
  @RequirePermission('apikeys.manage')
  createKey(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateApiKeyRequest)) body: CreateApiKeyRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.keys.create(a, ctx, body, m);
  }

  @Post('api-keys/:id/revoke')
  @HttpCode(200)
  @RequirePermission('apikeys.manage')
  revokeKey(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Meta() m: RequestMeta,
  ) {
    return this.keys.revoke(a, ctx, p.id, m);
  }

  // ---- health, providers, security, export
  @Get('operations/health')
  @RequirePermission('operations.read')
  health(@Tenant() ctx: TenantState) {
    return this.ops.health(ctx);
  }

  @Get('operations/providers')
  @RequirePermission('integrations.read')
  providers() {
    return { items: PROVIDERS };
  }

  @Get('security')
  @RequirePermission('settings.read')
  async security(@Tenant() ctx: TenantState) {
    const [t] = await this.db.system((tx) =>
      tx.select({ v: tenants.requireMfaForAdmins }).from(tenants).where(eq(tenants.id, ctx.tenantId)),
    );
    return { requireMfaForAdmins: t?.v ?? false };
  }

  /** Requiring MFA for owners/admins; the person turning it on must already use it (no self-lockout). */
  @Put('security')
  @RequirePermission('settings.manage')
  async setSecurity(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(MfaSettingRequest)) body: z.infer<typeof MfaSettingRequest>,
    @Meta() m: RequestMeta,
  ) {
    if (body.requireMfaForAdmins) {
      const [f] = await this.db.system((tx) =>
        tx.select({ c: mfaFactors.confirmedAt }).from(mfaFactors).where(eq(mfaFactors.userId, a.userId)),
      );
      if (!f?.c)
        throw new AppError(
          409,
          'MFA_ENROLMENT_REQUIRED',
          'Turn on two-step verification for your own account first',
        );
    }
    await this.db.system(async (tx) => {
      await tx
        .update(tenants)
        .set({ requireMfaForAdmins: body.requireMfaForAdmins })
        .where(eq(tenants.id, ctx.tenantId));
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: a.userId,
        action: 'security.mfa_requirement_changed',
        entityType: 'tenant',
        entityId: ctx.tenantId,
        newValues: body,
        correlationId: m.correlationId,
        ip: m.ip,
      });
    });
    return body;
  }

  @Get('orders-export.csv')
  @RequirePermission('orders.read')
  async exportOrders(
    @Tenant() ctx: TenantState,
    @Query(zod(OrdersExportQuery)) q: z.infer<typeof OrdersExportQuery>,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    return this.ops.ordersCsv(ctx, q);
  }
}

/** Phase 11 platform operations (operators only). */
@Controller('v1/platform/operations')
@PlatformRoute()
export class PlatformOpsController {
  constructor(private readonly ops: OpsService) {}

  @Get('health')
  @RequirePlatformPermission('platform.tenants.read')
  health() {
    return this.ops.platformHealth();
  }

  @Get('dead-events')
  @RequirePlatformPermission('platform.tenants.read')
  dead() {
    return this.ops.deadEvents();
  }

  @Post('dead-events/:id/replay')
  @HttpCode(200)
  @RequirePlatformPermission('platform.tenants.manage')
  replay(@Auth() a: AuthState, @Param(zod(IdParam)) p: Id, @Meta() m: RequestMeta) {
    return this.ops.replayDead(a, p.id, m);
  }
}
