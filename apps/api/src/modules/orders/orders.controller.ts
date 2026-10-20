import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import {
  AcceptQuotationRequest,
  ApplyDiscountCodeRequest,
  ApproveOrderRequest,
  CancelOrderRequest,
  CancelQuotationRequest,
  CheckoutRequest,
  ConvertQuotationRequest,
  CreateOrderRequest,
  CreateQuotationRequest,
  IdParam,
  OrderListQuery,
  PutCartLinesRequest,
  QuotationActionRequest,
  QuotationListQuery,
  RejectOrderRequest,
  SandboxPayRequest,
  UpdateOrderSettingsRequest,
  UpdateQuotationRequest,
  type z,
} from '@uc/contracts';
import type { Response } from 'express';
import { Auth, Meta, RequirePermission, Tenant } from '../../common/decorators';
import { AppError } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency.service';
import type { AppRequest, AuthState, RequestMeta, TenantState } from '../../common/request';
import { zod } from '../../common/zod.pipe';
import { DbService } from '../../db/db.service';
import { RedisService } from '../../db/redis.service';
import { loadFeatures } from '../access/access.service';
import { AdminRoute } from '../access/guards';
import { StorefrontResolver } from '../storefront/storefront.controller';
import { CustomerAuthService } from '../customers/customer-auth.service';
import { CheckoutService, type StorefrontScope } from './checkout.service';
import { OrdersService } from './orders.service';
import { PaymentsService } from './payments.service';
import { QuotationsService } from './quotations.service';

type Id = z.infer<typeof IdParam>;

@Controller('v1/admin')
@AdminRoute()
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly quotations: QuotationsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ---- settings
  @Get('order-settings')
  @RequirePermission('orders.read')
  settings(@Tenant() ctx: TenantState) {
    return this.orders.settings(ctx);
  }

  @Put('order-settings')
  @RequirePermission('settings.manage')
  updateSettings(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(UpdateOrderSettingsRequest)) body: UpdateOrderSettingsRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.orders.updateSettings(a, ctx, body, m);
  }

  // ---- orders
  @Get('orders')
  @RequirePermission('orders.read')
  list(@Tenant() ctx: TenantState, @Query(zod(OrderListQuery)) q: OrderListQuery) {
    return this.orders.list(ctx, q);
  }

  @Post('orders')
  @RequirePermission('orders.manage')
  async create(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateOrderRequest)) body: CreateOrderRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Meta() m: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.idempotency.run(
      {
        scope: `tenant:${ctx.tenantId}:user:${a.userId}`,
        key,
        route: 'POST /v1/admin/orders',
        request: body,
      },
      async () => ({ status: 201, body: await this.orders.create(a, ctx, body, m) }),
    );
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Get('orders/:id')
  @RequirePermission('orders.read')
  get(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.orders.get(ctx, p.id);
  }

  @Post('orders/:id/approve')
  @HttpCode(200)
  @RequirePermission('orders.approve')
  approve(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(ApproveOrderRequest)) body: ApproveOrderRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.orders.approve(a, ctx, p.id, body, m);
  }

  @Post('orders/:id/reject')
  @HttpCode(200)
  @RequirePermission('orders.approve')
  reject(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(RejectOrderRequest)) body: RejectOrderRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.orders.reject(a, ctx, p.id, body, m);
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  @RequirePermission('orders.manage')
  cancel(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(CancelOrderRequest)) body: CancelOrderRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.orders.cancel(a, ctx, p.id, body, m);
  }

  // ---- quotations
  @Get('quotations')
  @RequirePermission('orders.read')
  quotationList(@Tenant() ctx: TenantState, @Query(zod(QuotationListQuery)) q: QuotationListQuery) {
    return this.quotations.list(ctx, q);
  }

  @Post('quotations')
  @RequirePermission('orders.manage')
  createQuotation(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateQuotationRequest)) body: CreateQuotationRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.quotations.create(a, ctx, body, m);
  }

  @Get('quotations/:id')
  @RequirePermission('orders.read')
  quotation(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.quotations.get(ctx, p.id);
  }

  @Patch('quotations/:id')
  @RequirePermission('orders.manage')
  updateQuotation(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(UpdateQuotationRequest)) body: UpdateQuotationRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.quotations.update(a, ctx, p.id, body, m);
  }

  @Post('quotations/:id/send')
  @HttpCode(200)
  @RequirePermission('orders.manage')
  send(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(QuotationActionRequest)) body: QuotationActionRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.quotations.send(a, ctx, p.id, body, m);
  }

  @Post('quotations/:id/accept')
  @HttpCode(200)
  @RequirePermission('orders.manage')
  accept(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(AcceptQuotationRequest)) body: AcceptQuotationRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.quotations.accept(a, ctx, p.id, body, m);
  }

  @Post('quotations/:id/convert')
  @HttpCode(201)
  @RequirePermission('orders.manage')
  convert(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(ConvertQuotationRequest)) body: ConvertQuotationRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.quotations.convert(a, ctx, p.id, body, m);
  }

  @Post('quotations/:id/cancel')
  @HttpCode(200)
  @RequirePermission('orders.manage')
  cancelQuotation(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(CancelQuotationRequest)) body: CancelQuotationRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.quotations.cancel(a, ctx, p.id, body, m);
  }
}

/** Storefront cart, checkout and order status (domain-resolved, rate limited). */
@Controller('v1/storefront')
export class StorefrontOrdersController {
  constructor(
    private readonly resolver: StorefrontResolver,
    private readonly checkout: CheckoutService,
    private readonly idempotency: IdempotencyService,
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly customers: CustomerAuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async scope(req: AppRequest, bucket: string, limit: number): Promise<StorefrontScope> {
    if (
      !(await this.redis.hit(
        `rl:sf-${bucket}:${req.ip ?? 'unknown'}`,
        limit * this.config.STOREFRONT_RATE_LIMIT_MULTIPLIER,
        60,
      ))
    )
      throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again in a minute.');
    const { tenantId, channelId, preset } = await this.resolver.resolveContext(this.resolver.hostOf(req));
    const features = await this.db.tenant(tenantId, (tx) => loadFeatures(tx, tenantId, preset));
    return { tenantId, channelId, features };
  }

  /**
   * Adds the signed-in storefront customer (orders link to them; customer-only discounts can apply). Mutations need
   * the CSRF header — a cookie alone never attributes anything; reads (`read = true`) only price the cart.
   */
  private async withCustomer(
    req: AppRequest,
    scope: StorefrontScope,
    read = false,
  ): Promise<StorefrontScope> {
    if (!read && req.header('x-uc-csrf') !== '1') return scope;
    const shop = await this.customers.shop(req).catch(() => null);
    const signedIn = shop ? await this.customers.resolve(shop, this.customers.tokenFrom(req)) : null;
    return signedIn ? { ...scope, customerId: signedIn.customer.id } : scope;
  }

  @Post('carts')
  @HttpCode(201)
  async createCart(@Req() req: AppRequest) {
    return this.checkout.createCart(await this.scope(req, 'cart-create', 30));
  }

  @Get('carts/:id')
  async cart(
    @Req() req: AppRequest,
    @Param(zod(IdParam)) p: Id,
    @Headers('x-cart-token') token: string | undefined,
  ) {
    return this.checkout.getCart(
      await this.withCustomer(req, await this.scope(req, 'cart', 120), true),
      p.id,
      token,
    );
  }

  @Put('carts/:id/lines')
  async lines(
    @Req() req: AppRequest,
    @Param(zod(IdParam)) p: Id,
    @Headers('x-cart-token') token: string | undefined,
    @Body(zod(PutCartLinesRequest)) body: PutCartLinesRequest,
  ) {
    return this.checkout.putLines(
      await this.withCustomer(req, await this.scope(req, 'cart', 120)),
      p.id,
      token,
      body.lines,
    );
  }

  @Put('carts/:id/discount')
  async discount(
    @Req() req: AppRequest,
    @Param(zod(IdParam)) p: Id,
    @Headers('x-cart-token') token: string | undefined,
    @Body(zod(ApplyDiscountCodeRequest)) body: ApplyDiscountCodeRequest,
  ) {
    const scope = await this.withCustomer(req, await this.scope(req, 'cart-discount', 30));
    return this.checkout.setDiscountCode(scope, p.id, token, body.code);
  }

  @Post('checkouts')
  async placeCheckout(
    @Req() req: AppRequest,
    @Body(zod(CheckoutRequest)) body: CheckoutRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const scope = await this.withCustomer(req, await this.scope(req, 'checkout', 20));
    const result = await this.idempotency.run(
      {
        scope: `storefront:${scope.tenantId}:cart:${body.cartId}`,
        key,
        route: 'POST /v1/storefront/checkouts',
        request: body,
      },
      async () => ({ status: 201, body: await this.checkout.checkout(scope, body, key!) }),
    );
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Get('orders/:id')
  async order(
    @Req() req: AppRequest,
    @Param(zod(IdParam)) p: Id,
    @Headers('x-cart-token') token: string | undefined,
  ) {
    return this.checkout.getOrder(await this.scope(req, 'order', 120), p.id, token);
  }

  @Post('orders/:id/sandbox-payment')
  @HttpCode(200)
  async pay(
    @Req() req: AppRequest,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(SandboxPayRequest)) body: SandboxPayRequest,
  ) {
    return this.checkout.sandboxPay(await this.scope(req, 'pay', 20), p.id, body.cartToken, body.outcome);
  }
}

/** Public PSP callbacks (signature verified, replay protected). Only the sandbox provider exists in this build. */
@Controller('v1/payments')
export class PaymentWebhooksController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('sandbox/webhook')
  @HttpCode(200)
  webhook(@Body() body: unknown, @Headers('x-sandbox-signature') signature: string | undefined) {
    return this.payments.handleWebhook(body, signature);
  }
}
