import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ChannelListQuery,
  CreateChannelRequest,
  CreateStoreRequest,
  IdParam,
  StoreListQuery,
  UpdateChannelRequest,
  UpdateStoreRequest,
  type z,
} from '@uc/contracts';
import { Auth, Meta, RequirePermission, Tenant } from '../../common/decorators';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { zod } from '../../common/zod.pipe';
import { AdminRoute } from '../access/guards';
import { StoreService } from './store.service';

type Id = z.infer<typeof IdParam>;

@Controller('v1/admin')
@AdminRoute()
export class StoreController {
  constructor(private readonly service: StoreService) {}

  @Get('stores')
  @RequirePermission('stores.read')
  listStores(@Tenant() ctx: TenantState, @Query(zod(StoreListQuery)) query: z.infer<typeof StoreListQuery>) {
    return this.service.listStores(ctx, query);
  }

  @Post('stores')
  @RequirePermission('stores.manage')
  createStore(
    @Auth() auth: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateStoreRequest)) body: CreateStoreRequest,
    @Meta() meta: RequestMeta,
  ) {
    return this.service.createStore(auth, ctx, body, meta);
  }

  @Get('stores/:id')
  @RequirePermission('stores.read')
  getStore(@Tenant() ctx: TenantState, @Param(zod(IdParam)) params: Id) {
    return this.service.getStore(ctx, params.id);
  }

  @Patch('stores/:id')
  @RequirePermission('stores.manage')
  updateStore(
    @Auth() auth: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) params: Id,
    @Body(zod(UpdateStoreRequest)) body: UpdateStoreRequest,
    @Meta() meta: RequestMeta,
  ) {
    return this.service.updateStore(auth, ctx, params.id, body, meta);
  }

  @Get('channels')
  @RequirePermission('stores.read')
  listChannels(
    @Tenant() ctx: TenantState,
    @Query(zod(ChannelListQuery)) query: z.infer<typeof ChannelListQuery>,
  ) {
    return this.service.listChannels(ctx, query);
  }

  @Post('channels')
  @RequirePermission('stores.manage')
  createChannel(
    @Auth() auth: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateChannelRequest)) body: CreateChannelRequest,
    @Meta() meta: RequestMeta,
  ) {
    return this.service.createChannel(auth, ctx, body, meta);
  }

  @Get('channels/:id')
  @RequirePermission('stores.read')
  getChannel(@Tenant() ctx: TenantState, @Param(zod(IdParam)) params: Id) {
    return this.service.getChannel(ctx, params.id);
  }

  @Patch('channels/:id')
  @RequirePermission('stores.manage')
  updateChannel(
    @Auth() auth: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) params: Id,
    @Body(zod(UpdateChannelRequest)) body: UpdateChannelRequest,
    @Meta() meta: RequestMeta,
  ) {
    return this.service.updateChannel(auth, ctx, params.id, body, meta);
  }
}
