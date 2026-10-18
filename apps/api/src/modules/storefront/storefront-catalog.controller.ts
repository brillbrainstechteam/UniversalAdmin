import { Controller, Get, Injectable, Param, Query, Req, Res, StreamableFile } from '@nestjs/common';
import {
  IdParam,
  SlugParam,
  StorefrontProductQuery,
  type AttributeValues,
  type Page,
  type ProductOption,
  type StorefrontProduct,
  type z,
} from '@uc/contracts';
import {
  categories,
  channelPublications,
  collectionProducts,
  collections,
  jewellerySpecs,
  purityDefinitions,
  mediaAssets,
  productMedia,
  products,
  variants,
  type Tx,
} from '@uc/db';
import { and, asc, eq, gt, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Response } from 'express';
import { decodeCursor, paginate } from '../../common/cursor';
import { AppError } from '../../common/errors';
import { likePattern } from '../../common/mappers';
import type { AppRequest } from '../../common/request';
import { StorageService } from '../../common/storage.service';
import { zod } from '../../common/zod.pipe';
import { DbService } from '../../db/db.service';
import { StorefrontResolver } from './storefront.controller';

const mediaUrl = (id: string) => `/v1/storefront/media/${id}`;
const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found`);

/**
 * Public catalog for the storefront resolved from the request domain (ADR-003). Only ACTIVE products
 * PUBLISHED to that channel with at least one active variant are visible. No prices or stock (Phases 04/06).
 */
@Injectable()
export class StorefrontCatalogService {
  constructor(
    private readonly db: DbService,
    private readonly resolver: StorefrontResolver,
    private readonly storage: StorageService,
  ) {}

  private visible(channelId: string): SQL {
    return and(
      eq(products.status, 'active'),
      sql`exists (select 1 from ${channelPublications} pub where pub.product_id = "products"."id" and pub.channel_id = ${channelId} and pub.status = 'published')`,
      sql`exists (select 1 from ${variants} v where v.product_id = "products"."id" and v.status = 'active')`,
    )!;
  }

  private async scope(req: AppRequest) {
    return this.resolver.resolveContext(this.resolver.hostOf(req));
  }

  async list(req: AppRequest, query: z.infer<typeof StorefrontProductQuery>) {
    const { tenantId, channelId } = await this.scope(req);
    const cursor = decodeCursor(query.cursor);
    return this.db.tenant(tenantId, async (tx) => {
      const where: (SQL | undefined)[] = [eq(products.tenantId, tenantId), this.visible(channelId)];
      if (query.q)
        where.push(
          or(ilike(products.title, likePattern(query.q)), ilike(products.brand, likePattern(query.q))),
        );
      if (query.category) {
        const [c] = await tx
          .select({ id: categories.id })
          .from(categories)
          .where(and(eq(categories.tenantId, tenantId), eq(categories.slug, query.category)));
        if (!c) throw notFound('Category');
        where.push(eq(products.categoryId, c.id));
      }
      if (query.collection) {
        const [c] = await tx
          .select({ id: collections.id })
          .from(collections)
          .where(
            and(
              eq(collections.tenantId, tenantId),
              eq(collections.slug, query.collection),
              eq(collections.status, 'active'),
            ),
          );
        if (!c) throw notFound('Collection');
        where.push(
          sql`exists (select 1 from ${collectionProducts} cp where cp.product_id = "products"."id" and cp.collection_id = ${c.id})`,
        );
      }
      if (cursor) {
        const v = String(cursor.sortValue);
        where.push(or(gt(products.title, v), and(eq(products.title, v), gt(products.id, cursor.id))));
      }
      const rows = await tx
        .select({
          p: products,
          mediaId: sql<
            string | null
          >`(select pm.media_id from ${productMedia} pm where pm.product_id = "products"."id" order by pm.position limit 1)`,
          altText: sql<
            string | null
          >`(select m.alt_text from ${productMedia} pm join ${mediaAssets} m on m.id = pm.media_id where pm.product_id = "products"."id" order by pm.position limit 1)`,
        })
        .from(products)
        .where(and(...where))
        .orderBy(asc(products.title), asc(products.id))
        .limit(query.limit + 1);
      const page = paginate(
        rows.map((r) => ({ id: r.p.id, r })),
        query.limit,
        ({ r }) => r.p.title,
      );
      return {
        items: page.items.map(({ r }) => ({
          slug: r.p.slug,
          title: r.p.title,
          brand: r.p.brand,
          productType: r.p.productType,
          image: r.mediaId ? { url: mediaUrl(r.mediaId), altText: r.altText || r.p.title } : null,
        })),
        nextCursor: page.nextCursor,
      } satisfies Page<unknown>;
    });
  }

  private async findVisible(tx: Tx, tenantId: string, channelId: string, slug: string) {
    const [p] = await tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.slug, slug), this.visible(channelId)));
    if (!p) throw notFound('Product');
    return p;
  }

  async product(req: AppRequest, slug: string): Promise<StorefrontProduct> {
    const { tenantId, channelId } = await this.scope(req);
    return this.db.tenant(tenantId, async (tx) => {
      const p = await this.findVisible(tx, tenantId, channelId, slug);
      const [category] = p.categoryId
        ? await tx
            .select({ slug: categories.slug, name: categories.name })
            .from(categories)
            .where(eq(categories.id, p.categoryId))
        : [];
      const images = await tx
        .select({ id: mediaAssets.id, altText: mediaAssets.altText })
        .from(productMedia)
        .innerJoin(mediaAssets, eq(mediaAssets.id, productMedia.mediaId))
        .where(eq(productMedia.productId, p.id))
        .orderBy(asc(productMedia.position));
      const vs = await tx
        .select()
        .from(variants)
        .where(and(eq(variants.productId, p.id), eq(variants.status, 'active')))
        .orderBy(asc(variants.position));
      // Design specs only (nominal weights). Per-article actual weights need availability (Phases 04/09).
      const specs = vs.length
        ? await tx
            .select({ spec: jewellerySpecs, purity: purityDefinitions.label })
            .from(jewellerySpecs)
            .innerJoin(purityDefinitions, eq(purityDefinitions.id, jewellerySpecs.purityId))
            .where(
              inArray(
                jewellerySpecs.variantId,
                vs.map((v) => v.id),
              ),
            )
        : [];
      const specFor = new Map(specs.map((s) => [s.spec.variantId, s]));
      return {
        slug: p.slug,
        title: p.title,
        description: p.description,
        brand: p.brand,
        productType: p.productType,
        category: category ?? null,
        tags: p.tags,
        options: p.options as ProductOption[],
        attributes: p.attributes as AttributeValues,
        seo: { title: p.seoTitle ?? p.title, description: p.seoDescription },
        images: images.map((i) => ({ url: mediaUrl(i.id), altText: i.altText || p.title })),
        variants: vs.map((v) => ({
          sku: v.sku,
          title: v.title,
          optionValues: v.optionValues as Record<string, string>,
          jewellery: (() => {
            const s = p.productType === 'jewellery' ? specFor.get(v.id) : undefined;
            return s
              ? {
                  metal: s.spec.metal,
                  purity: s.purity,
                  colour: s.spec.colour,
                  grossG: s.spec.grossG,
                  netG: s.spec.netG,
                  stoneG: s.spec.stoneG,
                  qtyUnit: s.spec.qtyUnit,
                  piecesPerUnit: s.spec.piecesPerUnit,
                }
              : null;
          })(),
        })),
      };
    });
  }

  async categories(req: AppRequest) {
    const { tenantId } = await this.scope(req);
    const rows = await this.db.tenant(tenantId, (tx) =>
      tx
        .select()
        .from(categories)
        .where(eq(categories.tenantId, tenantId))
        .orderBy(asc(categories.position), asc(categories.name)),
    );
    const slugById = new Map(rows.map((r) => [r.id, r.slug]));
    return {
      items: rows.map((r) => ({
        slug: r.slug,
        name: r.name,
        parentSlug: r.parentId ? (slugById.get(r.parentId) ?? null) : null,
      })),
    };
  }

  async collection(req: AppRequest, slug: string) {
    const { tenantId } = await this.scope(req);
    const [c] = await this.db.tenant(tenantId, (tx) =>
      tx
        .select()
        .from(collections)
        .where(
          and(
            eq(collections.tenantId, tenantId),
            eq(collections.slug, slug),
            eq(collections.status, 'active'),
          ),
        ),
    );
    if (!c) throw notFound('Collection');
    return { slug: c.slug, title: c.title, description: c.description };
  }

  /** Serves an image only if it belongs to a product currently visible on this channel. */
  async media(req: AppRequest, mediaId: string) {
    const { tenantId, channelId } = await this.scope(req);
    const [asset] = await this.db.tenant(tenantId, (tx) =>
      tx
        .select({ m: mediaAssets })
        .from(mediaAssets)
        .innerJoin(productMedia, eq(productMedia.mediaId, mediaAssets.id))
        .innerJoin(products, eq(products.id, productMedia.productId))
        .where(and(eq(mediaAssets.tenantId, tenantId), eq(mediaAssets.id, mediaId), this.visible(channelId)))
        .limit(1),
    );
    if (!asset) throw notFound('Image');
    return { ...asset.m, body: await this.storage.get(asset.m.storageKey) };
  }
}

@Controller('v1/storefront')
export class StorefrontCatalogController {
  constructor(private readonly service: StorefrontCatalogService) {}

  @Get('catalog/products')
  list(
    @Req() req: AppRequest,
    @Query(zod(StorefrontProductQuery)) q: z.infer<typeof StorefrontProductQuery>,
  ) {
    return this.service.list(req, q);
  }

  @Get('catalog/products/:slug')
  product(@Req() req: AppRequest, @Param(zod(SlugParam)) p: z.infer<typeof SlugParam>) {
    return this.service.product(req, p.slug);
  }

  @Get('catalog/categories')
  categories(@Req() req: AppRequest) {
    return this.service.categories(req);
  }

  @Get('catalog/collections/:slug')
  collection(@Req() req: AppRequest, @Param(zod(SlugParam)) p: z.infer<typeof SlugParam>) {
    return this.service.collection(req, p.slug);
  }

  @Get('media/:id')
  async media(
    @Req() req: AppRequest,
    @Param(zod(IdParam)) p: z.infer<typeof IdParam>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const m = await this.service.media(req, p.id);
    res.setHeader('Content-Type', m.contentType);
    res.setHeader('Content-Length', String(m.byteSize));
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('ETag', `"${m.sha256}"`);
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    return new StreamableFile(m.body);
  }
}
