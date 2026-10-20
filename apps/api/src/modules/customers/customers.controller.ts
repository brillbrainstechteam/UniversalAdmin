import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import {
  CreateReturnRequest,
  CustomerListQuery,
  CustomerLoginRequest,
  IdParam,
  PageQuery,
  RegisterCustomerRequest,
  SaveAddressRequest,
  UpdateAddressRequest,
  UpdateCustomerStatusRequest,
  UpdatePreferencesRequest,
  UpdateProfileRequest,
  type z,
} from '@uc/contracts';
import type { Response } from 'express';
import { Auth, Meta, RequirePermission, Tenant } from '../../common/decorators';
import {
  metaOf,
  type AppRequest,
  type AuthState,
  type RequestMeta,
  type TenantState,
} from '../../common/request';
import { zod } from '../../common/zod.pipe';
import { AdminRoute } from '../access/guards';
import { AccountService } from './account.service';
import { CustomerAuthService } from './customer-auth.service';
import { CustomersService } from './customers.service';

type Id = z.infer<typeof IdParam>;

@Controller('v1/admin')
@AdminRoute()
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get('customers')
  @RequirePermission('customers.read')
  list(@Tenant() ctx: TenantState, @Query(zod(CustomerListQuery)) q: CustomerListQuery) {
    return this.customers.list(ctx, q);
  }

  @Get('customers/:id')
  @RequirePermission('customers.read')
  get(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.customers.get(ctx, p.id);
  }

  @Put('customers/:id/status')
  @RequirePermission('customers.manage')
  setStatus(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(UpdateCustomerStatusRequest)) body: UpdateCustomerStatusRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.customers.setStatus(a, ctx, p.id, body, m);
  }
}

/**
 * Storefront customer account (Phase 09). Cookie session on the merchant's own B2C domain; every mutation needs the
 * CSRF header and a same-domain Origin (CsrfGuard).
 */
@Controller('v1/storefront/account')
export class StorefrontAccountController {
  constructor(
    private readonly auth: CustomerAuthService,
    private readonly account: AccountService,
  ) {}

  @Post('register')
  @HttpCode(201)
  async register(
    @Req() req: AppRequest,
    @Body(zod(RegisterCustomerRequest)) body: RegisterCustomerRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, scope } = await this.auth.register(req, body, metaOf(req));
    this.auth.setCookie(res, token);
    return this.account.me(scope);
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Req() req: AppRequest,
    @Body(zod(CustomerLoginRequest)) body: CustomerLoginRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, scope } = await this.auth.login(req, body, metaOf(req));
    this.auth.setCookie(res, token);
    return this.account.me(scope);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req);
    this.auth.clearCookie(res);
  }

  @Get('me')
  async me(@Req() req: AppRequest) {
    return this.account.me(await this.auth.require(req));
  }

  @Put('profile')
  async profile(@Req() req: AppRequest, @Body(zod(UpdateProfileRequest)) body: UpdateProfileRequest) {
    return this.account.updateProfile(await this.auth.require(req), body);
  }

  @Put('preferences')
  async preferences(
    @Req() req: AppRequest,
    @Body(zod(UpdatePreferencesRequest)) body: UpdatePreferencesRequest,
  ) {
    return this.account.updatePreferences(await this.auth.require(req), body, metaOf(req));
  }

  @Get('addresses')
  async addresses(@Req() req: AppRequest) {
    return this.account.addresses(await this.auth.require(req));
  }

  @Post('addresses')
  @HttpCode(201)
  async addAddress(@Req() req: AppRequest, @Body(zod(SaveAddressRequest)) body: SaveAddressRequest) {
    return this.account.addAddress(await this.auth.require(req), body);
  }

  @Put('addresses/:id')
  async updateAddress(
    @Req() req: AppRequest,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(UpdateAddressRequest)) body: UpdateAddressRequest,
  ) {
    return this.account.updateAddress(await this.auth.require(req), p.id, body);
  }

  @Delete('addresses/:id')
  async deleteAddress(@Req() req: AppRequest, @Param(zod(IdParam)) p: Id) {
    return this.account.deleteAddress(await this.auth.require(req), p.id);
  }

  @Get('orders')
  async orders(@Req() req: AppRequest, @Query(zod(PageQuery)) q: z.infer<typeof PageQuery>) {
    return this.account.orders(await this.auth.require(req), q);
  }

  @Get('orders/:id')
  async order(@Req() req: AppRequest, @Param(zod(IdParam)) p: Id) {
    return this.account.order(await this.auth.require(req), p.id);
  }

  @Post('orders/:id/returns')
  @HttpCode(201)
  async requestReturn(
    @Req() req: AppRequest,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(CreateReturnRequest)) body: CreateReturnRequest,
  ) {
    return this.account.requestReturn(await this.auth.require(req), p.id, body, metaOf(req));
  }
}
