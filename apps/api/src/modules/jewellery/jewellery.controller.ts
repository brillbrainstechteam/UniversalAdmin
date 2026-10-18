import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  BulkSerialItemsRequest,
  CreatePurityRequest,
  CreateSerialItemRequest,
  IdParam,
  PutJewellerySpecRequest,
  ReviewSerialItemRequest,
  SerialItemListQuery,
  UpdateJewellerySettingsRequest,
  UpdatePurityRequest,
  UpdateSerialItemRequest,
  VariantParams,
  type z,
} from '@uc/contracts';
import { Auth, Meta, RequirePermission, Tenant } from '../../common/decorators';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { zod } from '../../common/zod.pipe';
import { AdminRoute } from '../access/guards';
import { JewelleryService } from './jewellery.service';
import { SerialItemsService } from './serial-items.service';

type Id = z.infer<typeof IdParam>;
type VP = z.infer<typeof VariantParams>;

@Controller('v1/admin')
@AdminRoute()
export class JewelleryController {
  constructor(
    private readonly jewellery: JewelleryService,
    private readonly items: SerialItemsService,
  ) {}

  @Get('jewellery/settings')
  @RequirePermission('catalog.read')
  getSettings(@Tenant() ctx: TenantState) {
    return this.jewellery.getSettings(ctx);
  }

  @Put('jewellery/settings')
  @RequirePermission('jewellery.edit')
  updateSettings(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(UpdateJewellerySettingsRequest)) body: UpdateJewellerySettingsRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.jewellery.updateSettings(a, ctx, body, m);
  }

  @Get('jewellery/purities')
  @RequirePermission('catalog.read')
  listPurities(@Tenant() ctx: TenantState) {
    return this.jewellery.listPurities(ctx);
  }

  @Post('jewellery/purities')
  @RequirePermission('jewellery.edit')
  createPurity(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreatePurityRequest)) body: CreatePurityRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.jewellery.createPurity(a, ctx, body, m);
  }

  @Patch('jewellery/purities/:id')
  @RequirePermission('jewellery.edit')
  updatePurity(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(UpdatePurityRequest)) body: UpdatePurityRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.jewellery.updatePurity(a, ctx, p.id, body, m);
  }

  @Get('products/:id/variants/:variantId/jewellery-spec')
  @RequirePermission('catalog.read')
  getSpec(@Tenant() ctx: TenantState, @Param(zod(VariantParams)) p: VP) {
    return this.jewellery.getSpec(ctx, p.id, p.variantId);
  }

  @Put('products/:id/variants/:variantId/jewellery-spec')
  @RequirePermission('jewellery.edit')
  putSpec(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(VariantParams)) p: VP,
    @Body(zod(PutJewellerySpecRequest)) body: PutJewellerySpecRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.jewellery.putSpec(a, ctx, p.id, p.variantId, body, m);
  }

  @Get('serial-items')
  @RequirePermission('catalog.read')
  list(@Tenant() ctx: TenantState, @Query(zod(SerialItemListQuery)) q: SerialItemListQuery) {
    return this.items.list(ctx, q);
  }

  @Post('serial-items')
  @RequirePermission('jewellery.edit')
  create(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateSerialItemRequest)) body: CreateSerialItemRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.items.create(a, ctx, body, m);
  }

  @Post('serial-items/bulk')
  @HttpCode(200)
  @RequirePermission('jewellery.edit')
  bulk(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(BulkSerialItemsRequest)) body: BulkSerialItemsRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.items.bulk(a, ctx, body, m);
  }

  @Get('serial-items/:id')
  @RequirePermission('catalog.read')
  get(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.items.get(ctx, p.id);
  }

  @Patch('serial-items/:id')
  @RequirePermission('jewellery.edit')
  update(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(UpdateSerialItemRequest)) body: UpdateSerialItemRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.items.update(a, ctx, p.id, body, m);
  }

  @Post('serial-items/:id/review')
  @HttpCode(200)
  @RequirePermission('jewellery.review')
  review(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(ReviewSerialItemRequest)) body: ReviewSerialItemRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.items.review(a, ctx, p.id, body, m);
  }
}
