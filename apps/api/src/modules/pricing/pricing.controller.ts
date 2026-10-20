import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import {
  ApproveRateRequest,
  CalculateRequest,
  CreatePriceBookRequest,
  CreatePriceRuleRequest,
  CreateQuoteRequest,
  CreateRateSourceRequest,
  CreateTaxRuleRequest,
  IdParam,
  MetalRateListQuery,
  PriceQuoteListQuery,
  PricingItemQuery,
  ProposeRateRequest,
  PublishRuleRequest,
  PullRatesRequest,
  PutListPricesRequest,
  RejectRateRequest,
  RetireRuleRequest,
  SaveRuleDraftRequest,
  StorefrontQuoteRequest,
  UpdatePriceBookRequest,
  UpdatePricingSettingsRequest,
  UpdateTaxRuleRequest,
  type z,
} from '@uc/contracts';
import { AppError } from '../../common/errors';
import { Auth, Meta, RequirePermission, Tenant } from '../../common/decorators';
import type { AppRequest, AuthState, RequestMeta, TenantState } from '../../common/request';
import { zod } from '../../common/zod.pipe';
import { DbService } from '../../db/db.service';
import { RedisService } from '../../db/redis.service';
import { AdminRoute } from '../access/guards';
import { loadFeatures } from '../access/access.service';
import { StorefrontResolver } from '../storefront/storefront.controller';
import { PricingService } from './pricing.service';
import { QuoteService } from './quote.service';
import { RatesService } from './rates.service';

type Id = z.infer<typeof IdParam>;

@Controller('v1/admin')
@AdminRoute()
export class PricingController {
  constructor(
    private readonly rates: RatesService,
    private readonly pricing: PricingService,
    private readonly quotes: QuoteService,
  ) {}

  // ---- rates
  @Get('rates/current')
  @RequirePermission('rates.read')
  current(@Tenant() ctx: TenantState) {
    return this.rates.current(ctx);
  }

  @Get('rates')
  @RequirePermission('rates.read')
  listRates(@Tenant() ctx: TenantState, @Query(zod(MetalRateListQuery)) q: MetalRateListQuery) {
    return this.rates.list(ctx, q);
  }

  @Post('rates')
  @RequirePermission('rates.edit')
  propose(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(ProposeRateRequest)) body: ProposeRateRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.rates.propose(a, ctx, body, m);
  }

  @Get('rates/sources')
  @RequirePermission('rates.read')
  sources(@Tenant() ctx: TenantState) {
    return this.rates.sources(ctx);
  }

  @Post('rates/sources')
  @RequirePermission('rates.edit')
  createSource(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateRateSourceRequest)) body: CreateRateSourceRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.rates.createSource(a, ctx, body, m);
  }

  @Post('rates/sources/:id/pull')
  @HttpCode(200)
  @RequirePermission('rates.edit')
  pull(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(PullRatesRequest)) body: PullRatesRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.rates.pull(a, ctx, p.id, body, m);
  }

  @Get('rates/:id')
  @RequirePermission('rates.read')
  getRate(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.rates.get(ctx, p.id);
  }

  @Post('rates/:id/approve')
  @HttpCode(200)
  @RequirePermission('rates.approve')
  approve(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(ApproveRateRequest)) body: ApproveRateRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.rates.approve(a, ctx, p.id, body, m);
  }

  @Post('rates/:id/reject')
  @HttpCode(200)
  @RequirePermission('rates.approve')
  reject(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(RejectRateRequest)) body: RejectRateRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.rates.reject(a, ctx, p.id, body, m);
  }

  // ---- settings, options, tax rules
  @Get('pricing/settings')
  @RequirePermission('pricing.read')
  settings(@Tenant() ctx: TenantState) {
    return this.pricing.settings(ctx);
  }

  @Put('pricing/settings')
  @RequirePermission('pricing.edit')
  updateSettings(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(UpdatePricingSettingsRequest)) body: UpdatePricingSettingsRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.pricing.updateSettings(a, ctx, body, m);
  }

  @Get('pricing/options')
  @RequirePermission('pricing.read')
  options(@Tenant() ctx: TenantState) {
    return this.pricing.options(ctx);
  }

  @Get('pricing/tax-rules')
  @RequirePermission('pricing.read')
  taxRules(@Tenant() ctx: TenantState) {
    return this.pricing.taxRules(ctx);
  }

  @Post('pricing/tax-rules')
  @RequirePermission('pricing.edit')
  createTaxRule(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateTaxRuleRequest)) body: CreateTaxRuleRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.pricing.createTaxRule(a, ctx, body, m);
  }

  @Patch('pricing/tax-rules/:id')
  @RequirePermission('pricing.edit')
  updateTaxRule(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(UpdateTaxRuleRequest)) body: UpdateTaxRuleRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.pricing.updateTaxRule(a, ctx, p.id, body, m);
  }

  // ---- books & list prices
  @Get('pricing/books')
  @RequirePermission('pricing.read')
  books(@Tenant() ctx: TenantState) {
    return this.pricing.listBooks(ctx);
  }

  @Post('pricing/books')
  @RequirePermission('pricing.edit')
  createBook(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreatePriceBookRequest)) body: CreatePriceBookRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.pricing.createBook(a, ctx, body, m);
  }

  @Get('pricing/books/:id')
  @RequirePermission('pricing.read')
  book(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.pricing.getBook(ctx, p.id);
  }

  @Patch('pricing/books/:id')
  @RequirePermission('pricing.edit')
  updateBook(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(UpdatePriceBookRequest)) body: UpdatePriceBookRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.pricing.updateBook(a, ctx, p.id, body, m);
  }

  @Get('pricing/books/:id/list-prices')
  @RequirePermission('pricing.read')
  listPrices(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.pricing.listPrices(ctx, p.id);
  }

  @Put('pricing/books/:id/list-prices')
  @RequirePermission('pricing.edit')
  putListPrices(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(PutListPricesRequest)) body: PutListPricesRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.pricing.putListPrices(a, ctx, p.id, body, m);
  }

  @Get('pricing/books/:id/rules')
  @RequirePermission('pricing.read')
  rules(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.pricing.listRules(ctx, p.id);
  }

  // ---- rules
  @Post('pricing/rules')
  @RequirePermission('pricing.edit')
  createRule(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreatePriceRuleRequest)) body: CreatePriceRuleRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.pricing.createRule(a, ctx, body, m);
  }

  @Get('pricing/rules/:id')
  @RequirePermission('pricing.read')
  rule(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.pricing.getRule(ctx, p.id);
  }

  @Put('pricing/rules/:id/draft')
  @RequirePermission('pricing.edit')
  saveDraft(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(SaveRuleDraftRequest)) body: SaveRuleDraftRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.pricing.saveDraft(a, ctx, p.id, body, m);
  }

  @Post('pricing/rules/:id/publish')
  @HttpCode(200)
  @RequirePermission('pricing.publish')
  publish(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(PublishRuleRequest)) body: PublishRuleRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.pricing.publish(a, ctx, p.id, body, m);
  }

  @Post('pricing/rules/:id/retire')
  @HttpCode(200)
  @RequirePermission('pricing.publish')
  retire(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(RetireRuleRequest)) body: RetireRuleRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.pricing.retire(a, ctx, p.id, body, m);
  }

  // ---- calculator & quotes
  @Get('pricing/items')
  @RequirePermission('pricing.read')
  items(@Tenant() ctx: TenantState, @Query(zod(PricingItemQuery)) q: PricingItemQuery) {
    return this.quotes.searchItems(ctx, q.q);
  }

  @Post('pricing/calculate')
  @HttpCode(200)
  @RequirePermission('pricing.read')
  calculate(@Tenant() ctx: TenantState, @Body(zod(CalculateRequest)) body: CalculateRequest) {
    return this.quotes.calculate(ctx, body);
  }

  @Get('pricing/quotes')
  @RequirePermission('pricing.read')
  listQuotes(@Tenant() ctx: TenantState, @Query(zod(PriceQuoteListQuery)) q: PriceQuoteListQuery) {
    return this.quotes.list(ctx, q);
  }

  @Post('pricing/quotes')
  @RequirePermission('pricing.read')
  createQuote(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateQuoteRequest)) body: CreateQuoteRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.quotes.create(a, ctx, body, m);
  }

  @Get('pricing/quotes/:id')
  @RequirePermission('pricing.read')
  quote(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.quotes.get(ctx, p.id);
  }

  @Post('pricing/quotes/:id/revalidate')
  @HttpCode(200)
  @RequirePermission('pricing.read')
  revalidate(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Meta() m: RequestMeta,
  ) {
    return this.quotes.revalidate(a, ctx, p.id, m);
  }
}

/** Public, domain-resolved price quotes for published products (rate limited per IP). */
@Controller('v1/storefront')
export class StorefrontPricingController {
  constructor(
    private readonly resolver: StorefrontResolver,
    private readonly quotes: QuoteService,
    private readonly db: DbService,
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('pricing-quotes')
  @HttpCode(201)
  async quote(@Req() req: AppRequest, @Body(zod(StorefrontQuoteRequest)) body: StorefrontQuoteRequest) {
    if (
      !(await this.redis.hit(
        `rl:sf-quote:${req.ip ?? 'unknown'}`,
        60 * this.config.STOREFRONT_RATE_LIMIT_MULTIPLIER,
        60,
      ))
    )
      throw new AppError(429, 'RATE_LIMITED', 'Too many price requests. Try again in a minute.');
    const { tenantId, channelId, preset } = await this.resolver.resolveContext(this.resolver.hostOf(req));
    const features = await this.db.tenant(tenantId, (tx) => loadFeatures(tx, tenantId, preset));
    return this.quotes.storefrontQuote({ tenantId, channelId, features }, body.lines);
  }
}
