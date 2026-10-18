import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import {
  CollectionListQuery,
  CreateAttributeDefinitionRequest,
  CreateCategoryRequest,
  CreateCollectionRequest,
  CreateImportRequest,
  CreateSavedViewRequest,
  IdParam,
  SetCollectionProductsRequest,
  UpdateAttributeDefinitionRequest,
  UpdateCategoryRequest,
  UpdateCollectionRequest,
  UpdateSavedViewRequest,
  z,
} from '@uc/contracts';
import type { Response } from 'express';
import { Auth, Meta, RequirePermission, Tenant } from '../../common/decorators';
import { IdempotencyService } from '../../common/idempotency.service';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { zod } from '../../common/zod.pipe';
import { AdminRoute } from '../access/guards';
import { ImportService } from './import.service';
import { SavedViewsService } from './saved-views.service';
import { TaxonomyService } from './taxonomy.service';

type Id = z.infer<typeof IdParam>;
const ImportListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(512).optional(),
});

@Controller('v1/admin')
@AdminRoute()
export class TaxonomyController {
  constructor(
    private readonly taxonomy: TaxonomyService,
    private readonly views: SavedViewsService,
    private readonly imports: ImportService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ---- categories
  @Get('categories')
  @RequirePermission('catalog.read')
  listCategories(@Tenant() ctx: TenantState) {
    return this.taxonomy.listCategories(ctx);
  }

  @Post('categories')
  @RequirePermission('catalog.edit')
  createCategory(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateCategoryRequest)) body: CreateCategoryRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.taxonomy.createCategory(a, ctx, body, m);
  }

  @Patch('categories/:id')
  @RequirePermission('catalog.edit')
  updateCategory(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(UpdateCategoryRequest)) body: UpdateCategoryRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.taxonomy.updateCategory(a, ctx, p.id, body, m);
  }

  @Delete('categories/:id')
  @HttpCode(204)
  @RequirePermission('catalog.edit')
  async deleteCategory(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Meta() m: RequestMeta,
  ) {
    await this.taxonomy.deleteCategory(a, ctx, p.id, m);
  }

  // ---- collections
  @Get('collections')
  @RequirePermission('catalog.read')
  listCollections(@Tenant() ctx: TenantState, @Query(zod(CollectionListQuery)) q: CollectionListQuery) {
    return this.taxonomy.listCollections(ctx, q);
  }

  @Post('collections')
  @RequirePermission('catalog.edit')
  createCollection(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateCollectionRequest)) body: CreateCollectionRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.taxonomy.createCollection(a, ctx, body, m);
  }

  @Get('collections/:id')
  @RequirePermission('catalog.read')
  getCollection(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.taxonomy.getCollection(ctx, p.id);
  }

  @Patch('collections/:id')
  @RequirePermission('catalog.edit')
  updateCollection(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(UpdateCollectionRequest)) body: UpdateCollectionRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.taxonomy.updateCollection(a, ctx, p.id, body, m);
  }

  @Put('collections/:id/products')
  @RequirePermission('catalog.edit')
  setCollectionProducts(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(SetCollectionProductsRequest)) body: SetCollectionProductsRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.taxonomy.setCollectionProducts(a, ctx, p.id, body, m);
  }

  // ---- attribute definitions
  @Get('attribute-definitions')
  @RequirePermission('catalog.read')
  listAttributes(@Tenant() ctx: TenantState) {
    return this.taxonomy.listAttributes(ctx);
  }

  @Post('attribute-definitions')
  @RequirePermission('catalog.edit')
  createAttribute(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateAttributeDefinitionRequest)) body: CreateAttributeDefinitionRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.taxonomy.createAttribute(a, ctx, body, m);
  }

  @Patch('attribute-definitions/:id')
  @RequirePermission('catalog.edit')
  updateAttribute(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(UpdateAttributeDefinitionRequest)) body: UpdateAttributeDefinitionRequest,
    @Meta() m: RequestMeta,
  ) {
    return this.taxonomy.updateAttribute(a, ctx, p.id, body, m);
  }

  // ---- saved views
  @Get('saved-views')
  @RequirePermission('catalog.read')
  listViews(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Query(zod(z.object({ resource: z.literal('products') }))) _q: unknown,
  ) {
    return this.views.list(a, ctx);
  }

  @Post('saved-views')
  @RequirePermission('catalog.read')
  createView(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateSavedViewRequest)) body: CreateSavedViewRequest,
  ) {
    return this.views.create(a, ctx, body);
  }

  @Patch('saved-views/:id')
  @RequirePermission('catalog.read')
  updateView(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Body(zod(UpdateSavedViewRequest)) body: UpdateSavedViewRequest,
  ) {
    return this.views.update(a, ctx, p.id, body);
  }

  @Delete('saved-views/:id')
  @HttpCode(204)
  @RequirePermission('catalog.read')
  async deleteView(@Auth() a: AuthState, @Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    await this.views.remove(a, ctx, p.id);
  }

  // ---- CSV imports
  @Get('catalog/imports')
  @RequirePermission('catalog.edit')
  listImports(@Tenant() ctx: TenantState, @Query(zod(ImportListQuery)) q: z.infer<typeof ImportListQuery>) {
    return this.imports.list(ctx, q);
  }

  @Post('catalog/imports')
  @RequirePermission('catalog.edit')
  async createImport(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Body(zod(CreateImportRequest)) body: CreateImportRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Meta() m: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.idempotency.run(
      {
        scope: `tenant:${ctx.tenantId}:user:${a.userId}`,
        key,
        route: 'POST /v1/admin/catalog/imports',
        request: body,
      },
      async () => ({ status: 201, body: await this.imports.preview(a, ctx, body, m) }),
    );
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Get('catalog/imports/:id')
  @RequirePermission('catalog.edit')
  getImport(@Tenant() ctx: TenantState, @Param(zod(IdParam)) p: Id) {
    return this.imports.get(ctx, p.id);
  }

  @Post('catalog/imports/:id/commit')
  @HttpCode(200)
  @RequirePermission('catalog.edit')
  commitImport(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Meta() m: RequestMeta,
  ) {
    return this.imports.commit(a, ctx, p.id, m);
  }

  @Post('catalog/imports/:id/discard')
  @HttpCode(200)
  @RequirePermission('catalog.edit')
  discardImport(
    @Auth() a: AuthState,
    @Tenant() ctx: TenantState,
    @Param(zod(IdParam)) p: Id,
    @Meta() m: RequestMeta,
  ) {
    return this.imports.discard(a, ctx, p.id, m);
  }
}
