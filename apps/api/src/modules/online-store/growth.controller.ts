import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  AddDomainRequest,
  CreatePageRequest,
  CreateRedirectRequest,
  DiscountListQuery,
  DocumentActionRequest,
  IdParam,
  PageQuery,
  PreviewTokenRequest,
  PublishRequest,
  RedirectQuery,
  ReportKey,
  ReportQuery,
  SaveCampaignRequest,
  SaveDiscountRequest,
  SaveDraftRequest,
  SaveSegmentRequest,
  SiteQuery,
  z,
} from '@uc/contracts';
import type { Response } from 'express';
import { Auth, Meta, RequirePermission, Tenant } from '../../common/decorators';
import type { AppRequest, AuthState, RequestMeta, TenantState } from '../../common/request';
import { zod } from '../../common/zod.pipe';
import { AdminRoute } from '../access/guards';
import { DiscountsService } from '../discounts/discounts.service';
import { MarketingService } from '../marketing/marketing.service';
import { ReportsService } from '../reports/reports.service';
import { StorefrontResolver } from '../storefront/storefront.controller';
import { OnlineStoreService } from './online-store.service';

type Id = z.infer<typeof IdParam>;
const VersionBody = z.object({ version: z.number().int().min(0) });
const ReportParam = z.object({ key: ReportKey });
const SlugParam = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(80),
});

@Controller('v1/admin/online-store')
@AdminRoute()
export class OnlineStoreController {
  constructor(private readonly store: OnlineStoreService) {}

  @Get('documents')
  @RequirePermission('content.manage')
  list(@Auth() a: AuthState, @Tenant() ctx: TenantState, @Query(zod(SiteQuery)) q: SiteQuery) {
    return this.store.list(ctx, a, q.channelId);
  }

  @Get('documents/:id')
  @RequirePermission('content.manage')
  get(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.store.get(ctx, p.id);
  }

  @Post('pages')
  @RequirePermission('content.manage')
  createPage(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreatePageRequest)) body: CreatePageRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.store.createPage(a, ctx, body, m);
  }

  @Put('documents/:id/draft')
  @RequirePermission('content.manage')
  saveDraft(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(SaveDraftRequest)) body: SaveDraftRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.store.saveDraft(a, ctx, p.id, body, m);
  }

  @Post('documents/:id/publish')
  @HttpCode(200)
  @RequirePermission('content.manage')
  publish(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(PublishRequest)) body: PublishRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.store.publish(a, ctx, p.id, body, m);
  }

  @Post('documents/:id/unpublish')
  @HttpCode(200)
  @RequirePermission('content.manage')
  unpublish(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(DocumentActionRequest)) body: DocumentActionRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.store.unpublish(a, ctx, p.id, body.version, m);
  }

  @Post('preview-tokens')
  @RequirePermission('content.manage')
  preview(
    @Tenant() ctx: TenantState,
    @Body(zod(PreviewTokenRequest)) body: z.infer<typeof PreviewTokenRequest>,
  ) {
    return this.store.previewToken(ctx, body.channelId);
  }

  @Get('redirects')
  @RequirePermission('content.manage')
  redirects(@Tenant() ctx: TenantState, @Query(zod(SiteQuery)) q: SiteQuery) {
    return this.store.redirects(ctx, q.channelId);
  }

  @Post('redirects')
  @RequirePermission('content.manage')
  addRedirect(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateRedirectRequest)) body: CreateRedirectRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.store.addRedirect(a, ctx, body, m);
  }

  @Delete('redirects/:id')
  @HttpCode(204)
  @RequirePermission('content.manage')
  async removeRedirect(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Meta() m: RequestMeta,
  ) {
    await this.store.removeRedirect(a, ctx, p.id, m);
  }

  @Get('domains')
  @RequirePermission('content.manage')
  domains(@Tenant() ctx: TenantState, @Query(zod(SiteQuery)) q: SiteQuery) {
    return this.store.domains(ctx, q.channelId);
  }

  @Post('domains')
  @RequirePermission('content.manage')
  addDomain(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(AddDomainRequest)) body: AddDomainRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.store.addDomain(a, ctx, body, m);
  }

  @Post('domains/:id/verify')
  @HttpCode(200)
  @RequirePermission('content.manage')
  verifyDomain(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Meta() m: RequestMeta,
  ) {
    return this.store.verifyDomain(a, ctx, p.id, m);
  }

  @Delete('domains/:id')
  @HttpCode(204)
  @RequirePermission('content.manage')
  async removeDomain(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Meta() m: RequestMeta,
  ) {
    await this.store.removeDomain(a, ctx, p.id, m);
  }
}

@Controller('v1/admin/discounts')
@AdminRoute()
export class DiscountsController {
  constructor(private readonly discounts: DiscountsService) {}

  @Get()
  @RequirePermission('discounts.manage')
  list(@Tenant() ctx: TenantState, @Query(zod(DiscountListQuery)) q: DiscountListQuery) {
    return this.discounts.list(ctx, q);
  }

  @Post()
  @RequirePermission('discounts.manage')
  create(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(SaveDiscountRequest)) body: SaveDiscountRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.discounts.create(a, ctx, body, m);
  }

  @Put(':id')
  @RequirePermission('discounts.manage')
  update(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(SaveDiscountRequest)) body: SaveDiscountRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.discounts.update(a, ctx, p.id, body, m);
  }
}

@Controller('v1/admin/marketing')
@AdminRoute()
export class MarketingController {
  constructor(private readonly marketing: MarketingService) {}

  @Get('segments')
  @RequirePermission('marketing.manage')
  segments(@Tenant() ctx: TenantState) {
    return this.marketing.segments(ctx);
  }

  @Post('segments')
  @RequirePermission('marketing.manage')
  createSegment(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(SaveSegmentRequest)) body: SaveSegmentRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.marketing.saveSegment(a, ctx, null, body, m);
  }

  @Put('segments/:id')
  @RequirePermission('marketing.manage')
  updateSegment(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(SaveSegmentRequest)) body: SaveSegmentRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.marketing.saveSegment(a, ctx, p.id, body, m);
  }

  @Get('segments/:id/members')
  @RequirePermission('marketing.manage')
  members(
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Query(zod(PageQuery)) q: z.infer<typeof PageQuery>,
  ) {
    return this.marketing.members(ctx, p.id, q);
  }

  @Get('campaigns')
  @RequirePermission('marketing.manage')
  campaigns(@Tenant() ctx: TenantState, @Query(zod(PageQuery)) q: z.infer<typeof PageQuery>) {
    return this.marketing.campaigns(ctx, q);
  }

  @Post('campaigns')
  @RequirePermission('marketing.manage')
  createCampaign(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(SaveCampaignRequest)) body: SaveCampaignRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.marketing.saveCampaign(a, ctx, null, body, m);
  }

  @Put('campaigns/:id')
  @RequirePermission('marketing.manage')
  updateCampaign(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(SaveCampaignRequest)) body: SaveCampaignRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.marketing.saveCampaign(a, ctx, p.id, body, m);
  }

  @Post('campaigns/:id/prepare')
  @HttpCode(200)
  @RequirePermission('marketing.manage')
  prepare(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(VersionBody)) body: z.infer<typeof VersionBody>,
    @Meta() m: RequestMeta,
  ) {
    return this.marketing.prepare(a, ctx, p.id, body.version, m);
  }

  @Get('campaigns/:id/recipients')
  @RequirePermission('marketing.manage')
  recipients(
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Query(zod(PageQuery)) q: z.infer<typeof PageQuery>,
  ) {
    return this.marketing.recipients(ctx, p.id, q);
  }
}

@Controller('v1/admin/reports')
@AdminRoute()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @RequirePermission('analytics.read')
  list(@Tenant() ctx: TenantState) {
    return this.reports.list(ctx);
  }

  @Get(':key')
  @RequirePermission('analytics.read')
  async run(
    @Tenant() ctx: TenantState,
    @Param(zod(ReportParam)) p: z.infer<typeof ReportParam>,
    @Query(zod(ReportQuery)) q: ReportQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reports.run(ctx, p.key, q);
    if (q.format !== 'csv') return result;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${p.key}-${result.filters.from}-${result.filters.to}.csv"`,
    );
    return ReportsService.toCsv(result);
  }
}

/** Published storefront content (Phase 10). Drafts only with a valid preview token for this tenant + channel. */
@Controller('v1/storefront')
export class StorefrontContentController {
  constructor(
    private readonly resolver: StorefrontResolver,
    private readonly store: OnlineStoreService,
  ) {}

  private async ctx(req: AppRequest, preview: string | undefined) {
    const { tenantId, channelId } = await this.resolver.resolveContext(this.resolver.hostOf(req));
    return { tenantId, channelId, preview: this.store.verifyPreview(preview, tenantId, channelId) };
  }

  @Get('site')
  async site(@Req() req: AppRequest, @Headers('x-preview-token') token: string | undefined) {
    const c = await this.ctx(req, token);
    return this.store.site(c.tenantId, c.channelId, c.preview);
  }

  @Get('pages/:slug')
  async page(
    @Req() req: AppRequest,
    @Param(zod(SlugParam)) p: z.infer<typeof SlugParam>,
    @Headers('x-preview-token') token: string | undefined,
  ) {
    const c = await this.ctx(req, token);
    return this.store.page(c.tenantId, c.channelId, p.slug, c.preview);
  }

  @Get('redirects')
  async redirect(@Req() req: AppRequest, @Query(zod(RedirectQuery)) q: z.infer<typeof RedirectQuery>) {
    const c = await this.ctx(req, undefined);
    return this.store.lookupRedirect(c.tenantId, c.channelId, q.path);
  }
}
