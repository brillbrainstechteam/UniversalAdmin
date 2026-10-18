import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import {
  AdjustmentRequest,
  ConditionChangeRequest,
  CreateReservationRequest,
  CreateStockCountRequest,
  CreateTransferRequest,
  IdParam,
  IssueListQuery,
  MovementQuery,
  PutChannelLocationsRequest,
  ReceiptRequest,
  ReleaseReservationRequest,
  ReservationListQuery,
  ResolveIssueRequest,
  StockCountListQuery,
  StockLevelQuery,
  TransferActionRequest,
  TransferListQuery,
  UpdateStockSettingsRequest,
  UpdateVariantStockSettingsRequest,
  WriteOffRequest,
  type z,
} from '@uc/contracts';
import type { Response } from 'express';
import { Auth, Meta, RequirePermission, Tenant } from '../../common/decorators';
import { IdempotencyService } from '../../common/idempotency.service';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { zod } from '../../common/zod.pipe';
import { AdminRoute } from '../access/guards';
import { InventoryQueryService } from './inventory-query.service';
import { InventoryService } from './inventory.service';

type Id = z.infer<typeof IdParam>;

@Controller('v1/admin/inventory')
@AdminRoute()
export class InventoryController {
  constructor(
    private readonly query: InventoryQueryService,
    private readonly service: InventoryService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** Runs a stock-posting command under the generic Idempotency-Key store (replays return the first result). */
  private async idempotent<T>(
    auth: AuthState,
    ctx: TenantState,
    route: string,
    key: string | undefined,
    body: unknown,
    res: Response,
    execute: () => Promise<T>,
  ): Promise<T> {
    const result = await this.idempotency.run(
      { scope: `tenant:${ctx.tenantId}:user:${auth.userId}`, key, route, request: body },
      async () => ({ status: 201, body: await execute() }),
    );
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Get('summary')
  @RequirePermission('inventory.read')
  summary(@Tenant() ctx: TenantState) {
    return this.query.summary(ctx);
  }

  @Get('levels')
  @RequirePermission('inventory.read')
  levels(@Tenant() ctx: TenantState, @Query(zod(StockLevelQuery)) q: StockLevelQuery) {
    return this.query.levels(ctx, q);
  }

  @Get('variants/:id')
  @RequirePermission('inventory.read')
  variant(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.query.variant(ctx, p.id);
  }

  @Put('variants/:id/settings')
  @RequirePermission('inventory.adjust')
  variantSettings(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(UpdateVariantStockSettingsRequest)) body: UpdateVariantStockSettingsRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.service.updateVariantSettings(a, ctx, p.id, body, m);
  }

  @Get('movements')
  @RequirePermission('inventory.read')
  movements(@Tenant() ctx: TenantState, @Query(zod(MovementQuery)) q: MovementQuery) {
    return this.query.movements(ctx, q);
  }

  @Get('settings')
  @RequirePermission('inventory.read')
  settings(@Tenant() ctx: TenantState) {
    return this.query.settings(ctx);
  }

  @Put('settings')
  @RequirePermission('inventory.adjust')
  updateSettings(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(UpdateStockSettingsRequest)) body: UpdateStockSettingsRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.service.updateSettings(a, ctx, body, m);
  }

  @Get('channels')
  @RequirePermission('inventory.read')
  channels(@Tenant() ctx: TenantState) {
    return this.query.channelLocations(ctx);
  }

  @Put('channels/:id/locations')
  @RequirePermission('stores.manage')
  channelLocations(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(PutChannelLocationsRequest)) body: PutChannelLocationsRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.service.putChannelLocations(a, ctx, p.id, body, m);
  }

  @Post('receipts')
  @RequirePermission('inventory.adjust')
  receive(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(ReceiptRequest)) body: ReceiptRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Meta() m: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.idempotent(a, ctx, 'POST /v1/admin/inventory/receipts', key, body, res, () =>
      this.service.receive(a, ctx, body, m),
    );
  }

  @Post('adjustments')
  @RequirePermission('inventory.adjust')
  adjust(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(AdjustmentRequest)) body: AdjustmentRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Meta() m: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.idempotent(a, ctx, 'POST /v1/admin/inventory/adjustments', key, body, res, () =>
      this.service.adjust(a, ctx, body, m),
    );
  }

  @Post('condition-changes')
  @RequirePermission('inventory.adjust')
  changeCondition(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(ConditionChangeRequest)) body: ConditionChangeRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.service.changeCondition(a, ctx, body, m);
  }

  @Post('serial-items/:id/write-off')
  @RequirePermission('inventory.adjust')
  writeOff(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(WriteOffRequest)) body: WriteOffRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.service.writeOff(a, ctx, p.id, body, m);
  }

  @Get('reservations')
  @RequirePermission('inventory.read')
  reservations(@Tenant() ctx: TenantState, @Query(zod(ReservationListQuery)) q: ReservationListQuery) {
    return this.query.reservations(ctx, q);
  }

  @Post('reservations')
  @RequirePermission('inventory.reserve')
  async reserve(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateReservationRequest)) body: CreateReservationRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Meta() m: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { reservation, replayed } = await this.service.reserve(a, ctx, body, key, m);
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return reservation;
  }

  @Post('reservations/:id/commit')
  @HttpCode(200)
  @RequirePermission('inventory.reserve')
  commit(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Meta() m: RequestMeta,
  ) {
    return this.service.commit(a, ctx, p.id, m);
  }

  @Post('reservations/:id/release')
  @HttpCode(200)
  @RequirePermission('inventory.reserve')
  release(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(ReleaseReservationRequest)) body: ReleaseReservationRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.service.release(a, ctx, p.id, body, m);
  }

  @Get('transfers')
  @RequirePermission('inventory.read')
  transfers(@Tenant() ctx: TenantState, @Query(zod(TransferListQuery)) q: TransferListQuery) {
    return this.query.transfers(ctx, q);
  }

  @Post('transfers')
  @RequirePermission('inventory.transfer')
  createTransfer(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateTransferRequest)) body: CreateTransferRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Meta() m: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.idempotent(a, ctx, 'POST /v1/admin/inventory/transfers', key, body, res, () =>
      this.service.createTransfer(a, ctx, body, m),
    );
  }

  @Get('transfers/:id')
  @RequirePermission('inventory.read')
  transfer(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.query.transfer(ctx, p.id);
  }

  @Post('transfers/:id/receive')
  @HttpCode(200)
  @RequirePermission('inventory.transfer')
  receiveTransfer(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(TransferActionRequest)) body: TransferActionRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.service.receiveTransfer(a, ctx, p.id, body, m);
  }

  @Post('transfers/:id/cancel')
  @HttpCode(200)
  @RequirePermission('inventory.transfer')
  cancelTransfer(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(TransferActionRequest)) body: TransferActionRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.service.cancelTransfer(a, ctx, p.id, body, m);
  }

  @Get('counts')
  @RequirePermission('inventory.read')
  counts(@Tenant() ctx: TenantState, @Query(zod(StockCountListQuery)) q: StockCountListQuery) {
    return this.query.counts(ctx, q);
  }

  @Post('counts')
  @RequirePermission('inventory.adjust')
  async createCount(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateStockCountRequest)) body: CreateStockCountRequest,
    @Meta() m: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const count = await this.service.count(a, ctx, body, m);
    res.status(count.status === 'preview' ? 200 : 201);
    return count;
  }

  @Get('counts/:id')
  @RequirePermission('inventory.read')
  count(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.query.count(ctx, p.id);
  }

  @Get('issues')
  @RequirePermission('inventory.read')
  issues(@Tenant() ctx: TenantState, @Query(zod(IssueListQuery)) q: IssueListQuery) {
    return this.query.issues(ctx, q);
  }

  @Post('issues/:id/resolve')
  @HttpCode(200)
  @RequirePermission('inventory.adjust')
  resolve(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(ResolveIssueRequest)) body: ResolveIssueRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.service.resolveIssue(a, ctx, p.id, body, m);
  }

  @Post('reconcile')
  @HttpCode(200)
  @RequirePermission('inventory.adjust')
  reconcile(@Auth() a: AuthState, @Tenant() ctx: TenantState, @Meta() m: RequestMeta) {
    return this.service.reconcile(a, ctx, m);
  }
}
