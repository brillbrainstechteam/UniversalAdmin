import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ChannelParams,
  CreateProductRequest,
  CreateVariantRequest,
  IdParam,
  MAX_MEDIA_BYTES,
  MediaParams,
  ProductListQuery,
  UpdateProductMediaRequest,
  UpdateProductRequest,
  UpdateVariantRequest,
  VariantIdParams,
  type z,
} from '@uc/contracts';
import type { Response } from 'express';
import { AllowTenantQuery, Auth, Meta, RequirePermission, Tenant } from '../../common/decorators';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { zod } from '../../common/zod.pipe';
import { AdminRoute } from '../access/guards';
import { CatalogService } from './catalog.service';

type Id = z.infer<typeof IdParam>;

const upload = FileInterceptor('file', { limits: { fileSize: MAX_MEDIA_BYTES, files: 1, fields: 0 } });

@Controller('v1/admin')
@AdminRoute()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('products')
  @RequirePermission('catalog.read')
  list(@Tenant() ctx: TenantState, @Query(zod(ProductListQuery)) query: ProductListQuery) {
    return this.catalog.list(ctx, query);
  }

  @Post('products')
  @RequirePermission('catalog.edit')
  create(
    @Auth() auth: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateProductRequest)) body: CreateProductRequest,
    @Meta() meta: RequestMeta,
  ) {
    return this.catalog.create(auth, ctx, body, meta);
  }

  @Get('products/:id')
  @RequirePermission('catalog.read')
  get(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.catalog.get(ctx, p.id);
  }

  @Patch('products/:id')
  @RequirePermission('catalog.edit')
  update(
    @Auth() auth: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(UpdateProductRequest)) body: UpdateProductRequest,
    @Meta() meta: RequestMeta,
  ) {
    return this.catalog.update(auth, ctx, p.id, body, meta);
  }

  @Post('products/:id/variants')
  @RequirePermission('catalog.edit')
  addVariant(
    @Auth() auth: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(CreateVariantRequest)) body: CreateVariantRequest,
    @Meta() meta: RequestMeta,
  ) {
    return this.catalog.addVariant(auth, ctx, p.id, body, meta);
  }

  @Patch('products/:id/variants/:variantId')
  @RequirePermission('catalog.edit')
  updateVariant(
    @Auth() auth: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(VariantIdParams)) p: z.infer<typeof VariantIdParams>,
    @Body(zod(UpdateVariantRequest)) body: UpdateVariantRequest,
    @Meta() meta: RequestMeta,
  ) {
    return this.catalog.updateVariant(auth, ctx, p.id, p.variantId, body, meta);
  }

  @Post('products/:id/media')
  @RequirePermission('catalog.edit')
  @UseInterceptors(upload)
  uploadMedia(
    @Auth() auth: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @UploadedFile() file: { buffer: Buffer; originalname: string; size: number } | undefined,
    @Meta() meta: RequestMeta,
  ) {
    return this.catalog.uploadMedia(auth, ctx, p.id, file, meta);
  }

  @Patch('products/:id/media')
  @RequirePermission('catalog.edit')
  updateMedia(
    @Auth() auth: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(UpdateProductMediaRequest)) body: z.infer<typeof UpdateProductMediaRequest>,
    @Meta() meta: RequestMeta,
  ) {
    return this.catalog.updateMedia(auth, ctx, p.id, body, meta);
  }

  @Delete('products/:id/media/:mediaId')
  @RequirePermission('catalog.edit')
  removeMedia(
    @Auth() auth: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(MediaParams)) p: z.infer<typeof MediaParams>,
    @Meta() meta: RequestMeta,
  ) {
    return this.catalog.removeMedia(auth, ctx, p.id, p.mediaId, meta);
  }

  @Get('media/:id/content')
  @RequirePermission('catalog.read')
  @AllowTenantQuery()
  async mediaContent(
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const media = await this.catalog.mediaContent(ctx, p.id);
    res.setHeader('Content-Type', media.contentType);
    res.setHeader('Content-Length', String(media.byteSize));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('ETag', `"${media.sha256}"`);
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    return new StreamableFile(media.body);
  }

  @Put('products/:id/publications/:channelId')
  @HttpCode(200)
  @RequirePermission('catalog.publish')
  publish(
    @Auth() auth: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(ChannelParams)) p: z.infer<typeof ChannelParams>,
    @Meta() meta: RequestMeta,
  ) {
    return this.catalog.publish(auth, ctx, p.id, p.channelId, meta);
  }

  @Delete('products/:id/publications/:channelId')
  @RequirePermission('catalog.publish')
  unpublish(
    @Auth() auth: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(ChannelParams)) p: z.infer<typeof ChannelParams>,
    @Meta() meta: RequestMeta,
  ) {
    return this.catalog.unpublish(auth, ctx, p.id, p.channelId, meta);
  }
}
