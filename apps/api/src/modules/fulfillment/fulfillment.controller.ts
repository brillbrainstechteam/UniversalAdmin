import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import {
  CancelRemainingRequest,
  CreateRefundRequest,
  CreateReturnRequest,
  CreateShipmentRequest,
  DecideReturnRequest,
  IdParam,
  ReceiveReturnRequest,
  ReturnListQuery,
  ShipmentActionRequest,
  ShipShipmentRequest,
  Uuid,
  z,
} from '@uc/contracts';
import type { Response } from 'express';
import { Auth, Meta, RequirePermission, Tenant } from '../../common/decorators';
import { IdempotencyService } from '../../common/idempotency.service';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { zod } from '../../common/zod.pipe';
import { AdminRoute } from '../access/guards';
import { FulfillmentService } from './fulfillment.service';
import { RefundsService } from './refunds.service';
import { ReturnsService } from './returns.service';

type Id = z.infer<typeof IdParam>;
const ShipmentParam = z.object({ id: Uuid, shipmentId: Uuid });
type ShipmentId = z.infer<typeof ShipmentParam>;

/** Phase 09 staff fulfilment: shipments, unshipped-item cancellation, returns and refunds (ADR-024). */
@Controller('v1/admin')
@AdminRoute()
export class FulfillmentController {
  constructor(
    private readonly fulfillment: FulfillmentService,
    private readonly returns: ReturnsService,
    private readonly refunds: RefundsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post('orders/:id/shipments')
  @RequirePermission('fulfillment.manage')
  createShipment(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(CreateShipmentRequest)) body: CreateShipmentRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.fulfillment.create(a, ctx, p.id, body, m);
  }

  @Post('orders/:id/shipments/:shipmentId/ship')
  @HttpCode(200)
  @RequirePermission('fulfillment.manage')
  ship(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(ShipmentParam)) p: ShipmentId,
    @Body(zod(ShipShipmentRequest)) body: ShipShipmentRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.fulfillment.ship(a, ctx, p.id, p.shipmentId, body, m);
  }

  @Post('orders/:id/shipments/:shipmentId/deliver')
  @HttpCode(200)
  @RequirePermission('fulfillment.manage')
  deliver(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(ShipmentParam)) p: ShipmentId,
    @Body(zod(ShipmentActionRequest)) body: ShipmentActionRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.fulfillment.deliver(a, ctx, p.id, p.shipmentId, body, m);
  }

  @Post('orders/:id/shipments/:shipmentId/cancel')
  @HttpCode(200)
  @RequirePermission('fulfillment.manage')
  cancelShipment(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(ShipmentParam)) p: ShipmentId,
    @Body(zod(ShipmentActionRequest)) body: ShipmentActionRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.fulfillment.cancel(a, ctx, p.id, p.shipmentId, body, m);
  }

  @Post('orders/:id/cancel-remaining')
  @HttpCode(200)
  @RequirePermission('orders.manage')
  cancelRemaining(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(CancelRemainingRequest)) body: CancelRemainingRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.fulfillment.cancelRemaining(a, ctx, p.id, body, m);
  }

  @Post('orders/:id/returns')
  @RequirePermission('fulfillment.manage')
  createReturn(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(CreateReturnRequest)) body: CreateReturnRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.returns.create(a, ctx, p.id, body, m);
  }

  @Get('returns')
  @RequirePermission('orders.read')
  listReturns(@Tenant() ctx: TenantState, @Query(zod(ReturnListQuery)) q: ReturnListQuery) {
    return this.returns.list(ctx, q);
  }

  @Post('returns/:id/decide')
  @HttpCode(200)
  @RequirePermission('fulfillment.manage')
  decideReturn(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(DecideReturnRequest)) body: DecideReturnRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.returns.decide(a, ctx, p.id, body, m);
  }

  @Post('returns/:id/receive')
  @HttpCode(200)
  @RequirePermission('fulfillment.manage')
  receiveReturn(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(ReceiveReturnRequest)) body: ReceiveReturnRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.returns.receive(a, ctx, p.id, body, m);
  }

  @Post('orders/:id/refunds')
  @RequirePermission('payments.refund')
  async refund(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(CreateRefundRequest)) body: CreateRefundRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Meta() m: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.idempotency.run(
      {
        scope: `tenant:${ctx.tenantId}:refund`,
        key,
        route: 'POST /v1/admin/orders/:id/refunds',
        request: { order: p.id, ...body },
      },
      async () => ({ status: 201, body: await this.refunds.create(a, ctx, p.id, body, key!, m) }),
    );
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }
}
