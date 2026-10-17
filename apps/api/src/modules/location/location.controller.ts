import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  CreateLocationRequest,
  IdParam,
  LocationListQuery,
  UpdateLocationRequest,
  type z,
} from '@uc/contracts';
import { Auth, Meta, RequirePermission, Tenant } from '../../common/decorators';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { zod } from '../../common/zod.pipe';
import { AdminRoute } from '../access/guards';
import { LocationService } from './location.service';

type Id = z.infer<typeof IdParam>;

@Controller('v1/admin/locations')
@AdminRoute()
export class LocationController {
  constructor(private readonly service: LocationService) {}

  @Get()
  @RequirePermission('locations.read')
  list(@Tenant() ctx: TenantState, @Query(zod(LocationListQuery)) query: LocationListQuery) {
    return this.service.list(ctx, query);
  }

  @Post()
  @RequirePermission('locations.manage')
  create(
    @Auth() auth: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateLocationRequest)) body: CreateLocationRequest,
    @Meta() meta: RequestMeta,
  ) {
    return this.service.create(auth, ctx, body, meta);
  }

  @Get(':id')
  @RequirePermission('locations.read')
  get(@Tenant() ctx: TenantState, @Param(zod(IdParam)) params: Id) {
    return this.service.get(ctx, params.id);
  }

  @Patch(':id')
  @RequirePermission('locations.manage')
  update(
    @Auth() auth: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) params: Id,
    @Body(zod(UpdateLocationRequest)) body: UpdateLocationRequest,
    @Meta() meta: RequestMeta,
  ) {
    return this.service.update(auth, ctx, params.id, body, meta);
  }
}
