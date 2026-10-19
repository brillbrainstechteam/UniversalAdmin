import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import {
  AcceptBuyerInvitationRequest,
  BuyerAcceptQuotationRequest,
  BuyerCatalogQuery,
  BuyerDecisionRequest,
  BuyerLoginRequest,
  BuyerOrderListQuery,
  BuyerPlaceOrderRequest,
  BuyerPriceRequest,
  BuyerRfqRequest,
  CompanyListQuery,
  CreateCompanyLocationRequest,
  CreateCompanyRequest,
  DeclineRfqRequest,
  IdParam,
  InvitationPreviewRequest,
  InviteBuyerRequest,
  PageQuery,
  QuoteRfqRequest,
  RecordCreditEntryRequest,
  RfqListQuery,
  RfqMessageRequest,
  UpdateBuyerRequest,
  UpdateCompanyLocationRequest,
  UpdateCompanyRequest,
  Uuid,
  z,
} from '@uc/contracts';
import type { Response } from 'express';
import { Auth, Meta, RequirePermission, Tenant } from '../../common/decorators';
import type { AppRequest, AuthState, RequestMeta, TenantState } from '../../common/request';
import { metaOf } from '../../common/request';
import { zod } from '../../common/zod.pipe';
import { AdminRoute } from '../access/guards';
import { SessionService } from '../auth/session.service';
import { BuyerService } from './buyer.service';
import { CompaniesService } from './companies.service';
import { RfqsService } from './rfqs.service';

type Id = z.infer<typeof IdParam>;
const CompanyChild = z.object({ id: Uuid, childId: Uuid });
type Child = z.infer<typeof CompanyChild>;

@Controller('v1/admin')
@AdminRoute()
export class CompaniesController {
  constructor(
    private readonly companies: CompaniesService,
    private readonly rfqs: RfqsService,
  ) {}

  @Get('companies')
  @RequirePermission('companies.read')
  list(@Auth() a: AuthState, @Tenant() ctx: TenantState, @Query(zod(CompanyListQuery)) q: CompanyListQuery) {
    return this.companies.list(a, ctx, q);
  }

  @Post('companies')
  @RequirePermission('companies.manage')
  create(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateCompanyRequest)) body: CreateCompanyRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.companies.create(a, ctx, body, m);
  }

  @Get('companies/:id')
  @RequirePermission('companies.read')
  get(@Auth() a: AuthState, @Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.companies.get(a, ctx, p.id);
  }

  @Patch('companies/:id')
  @RequirePermission('companies.manage')
  update(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(UpdateCompanyRequest)) body: UpdateCompanyRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.companies.update(a, ctx, p.id, body, m);
  }

  @Post('companies/:id/locations')
  @RequirePermission('companies.manage')
  addLocation(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(CreateCompanyLocationRequest)) body: CreateCompanyLocationRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.companies.addLocation(a, ctx, p.id, body, m);
  }

  @Patch('companies/:id/locations/:childId')
  @RequirePermission('companies.manage')
  updateLocation(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(CompanyChild)) p: Child,
    @Body(zod(UpdateCompanyLocationRequest)) body: UpdateCompanyLocationRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.companies.updateLocation(a, ctx, p.id, p.childId, body, m);
  }

  @Post('companies/:id/buyers')
  @RequirePermission('companies.manage')
  invite(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(InviteBuyerRequest)) body: InviteBuyerRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.companies.inviteBuyer(a, ctx, p.id, body, m);
  }

  @Patch('companies/:id/buyers/:childId')
  @RequirePermission('companies.manage')
  updateBuyer(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(CompanyChild)) p: Child,
    @Body(zod(UpdateBuyerRequest)) body: UpdateBuyerRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.companies.updateBuyer(a, ctx, p.id, p.childId, body, m);
  }

  @Get('companies/:id/credit')
  @RequirePermission('companies.read')
  credit(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Query(zod(PageQuery)) q: PageQuery,
  ) {
    return this.companies.credit(a, ctx, p.id, q);
  }

  @Post('companies/:id/credit')
  @RequirePermission('companies.manage')
  recordCredit(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(RecordCreditEntryRequest)) body: RecordCreditEntryRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.companies.recordCredit(a, ctx, p.id, body, m);
  }

  @Get('rfqs')
  @RequirePermission('companies.read')
  rfqList(@Auth() a: AuthState, @Tenant() ctx: TenantState, @Query(zod(RfqListQuery)) q: RfqListQuery) {
    return this.rfqs.list(a, ctx, q);
  }

  @Get('rfqs/:id')
  @RequirePermission('companies.read')
  rfq(@Auth() a: AuthState, @Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.rfqs.get(a, ctx, p.id);
  }

  @Post('rfqs/:id/messages')
  @HttpCode(200)
  @RequirePermission('orders.manage')
  rfqMessage(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(RfqMessageRequest)) body: RfqMessageRequest,
  ) {
    return this.rfqs.message(a, ctx, p.id, body);
  }

  @Post('rfqs/:id/quote')
  @HttpCode(200)
  @RequirePermission('orders.manage')
  quoteRfq(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(QuoteRfqRequest)) body: QuoteRfqRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.rfqs.quote(a, ctx, p.id, body, m);
  }

  @Post('rfqs/:id/decline')
  @HttpCode(200)
  @RequirePermission('orders.manage')
  declineRfq(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(DeclineRfqRequest)) body: DeclineRfqRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.rfqs.decline(a, ctx, p.id, body, m);
  }
}

/** Buyer portal API: domain-resolved tenant, `buyer` session, company-scoped data (ADR-023). */
@Controller('v1/storefront/b2b')
export class BuyerController {
  constructor(
    private readonly buyers: BuyerService,
    private readonly sessions: SessionService,
  ) {}

  @Post('auth/login')
  @HttpCode(200)
  async login(
    @Req() req: AppRequest,
    @Body(zod(BuyerLoginRequest)) body: BuyerLoginRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token } = await this.buyers.login(req, body.email, body.password, metaOf(req));
    this.sessions.setCookie(res, 'buyer', token);
    req.cookies = { ...(req.cookies as Record<string, string>), uc_b_sess: token };
    return this.buyers.context(await this.buyers.scope(req));
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    await this.buyers.logout(req);
    this.sessions.clearCookie(res, 'buyer');
  }

  @Get('me')
  async me(@Req() req: AppRequest) {
    return this.buyers.context(await this.buyers.scope(req));
  }

  @Post('invitations/preview')
  @HttpCode(200)
  preview(@Req() req: AppRequest, @Body(zod(InvitationPreviewRequest)) body: { token: string }) {
    return this.buyers.previewInvitation(req, body.token);
  }

  @Post('invitations/accept')
  @HttpCode(200)
  accept(
    @Req() req: AppRequest,
    @Body(zod(AcceptBuyerInvitationRequest)) body: AcceptBuyerInvitationRequest,
  ) {
    return this.buyers.acceptInvitation(req, body, metaOf(req));
  }

  @Get('catalog')
  async catalog(@Req() req: AppRequest, @Query(zod(BuyerCatalogQuery)) q: BuyerCatalogQuery) {
    return this.buyers.catalog(await this.buyers.scope(req), q);
  }

  @Post('price')
  @HttpCode(200)
  async price(@Req() req: AppRequest, @Body(zod(BuyerPriceRequest)) body: BuyerPriceRequest) {
    return this.buyers.price(await this.buyers.scope(req), body);
  }

  @Post('orders')
  @HttpCode(201)
  async placeOrder(@Req() req: AppRequest, @Body(zod(BuyerPlaceOrderRequest)) body: BuyerPlaceOrderRequest) {
    return this.buyers.placeOrder(await this.buyers.scope(req), body, metaOf(req));
  }

  @Get('orders')
  async orders(@Req() req: AppRequest, @Query(zod(BuyerOrderListQuery)) q: BuyerOrderListQuery) {
    return this.buyers.orders(await this.buyers.scope(req), q);
  }

  @Get('orders/:id')
  async order(@Req() req: AppRequest, @Param(zod(IdParam)) p: Id) {
    return this.buyers.order(await this.buyers.scope(req), p.id);
  }

  @Post('orders/:id/approve')
  @HttpCode(200)
  async approve(
    @Req() req: AppRequest,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(BuyerDecisionRequest)) body: BuyerDecisionRequest,
  ) {
    return this.buyers.decide(await this.buyers.scope(req), p.id, true, body, metaOf(req));
  }

  @Post('orders/:id/reject')
  @HttpCode(200)
  async reject(
    @Req() req: AppRequest,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(BuyerDecisionRequest)) body: BuyerDecisionRequest,
  ) {
    return this.buyers.decide(await this.buyers.scope(req), p.id, false, body, metaOf(req));
  }

  @Post('rfqs')
  @HttpCode(201)
  async createRfq(@Req() req: AppRequest, @Body(zod(BuyerRfqRequest)) body: BuyerRfqRequest) {
    return this.buyers.createRfq(await this.buyers.scope(req), body, metaOf(req));
  }

  @Get('rfqs')
  async rfqs(@Req() req: AppRequest, @Query(zod(PageQuery)) q: PageQuery) {
    return this.buyers.rfqList(await this.buyers.scope(req), q);
  }

  @Get('rfqs/:id')
  async rfq(@Req() req: AppRequest, @Param(zod(IdParam)) p: Id) {
    return this.buyers.rfq(await this.buyers.scope(req), p.id);
  }

  @Post('rfqs/:id/messages')
  @HttpCode(200)
  async rfqMessage(
    @Req() req: AppRequest,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(RfqMessageRequest)) body: RfqMessageRequest,
  ) {
    return this.buyers.rfqMessage(await this.buyers.scope(req), p.id, body);
  }

  @Get('quotations')
  async quotations(@Req() req: AppRequest) {
    return this.buyers.quotations(await this.buyers.scope(req));
  }

  @Post('quotations/:id/accept')
  @HttpCode(201)
  async acceptQuotation(
    @Req() req: AppRequest,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(BuyerAcceptQuotationRequest)) body: BuyerAcceptQuotationRequest,
  ) {
    return this.buyers.acceptQuotation(await this.buyers.scope(req), p.id, body, metaOf(req));
  }
}
