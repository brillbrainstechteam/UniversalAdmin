import { Injectable } from '@nestjs/common';
import {
  MAX_MEDIA_BYTES,
  slugify,
  validateAttributes,
  type AttributeValues,
  type CreateProductRequest,
  type CreateVariantRequest,
  type Page,
  type Product,
  type ProductListQuery,
  type ProductOption,
  type ProductStatus,
  type ProductSummary,
  type Publication,
  type UpdateProductMediaRequest,
  type UpdateProductRequest,
  type UpdateVariantRequest,
  type Variant,
} from '@uc/contracts';
import {
  attributeDefinitions,
  categories,
  channelPublications,
  channels,
  collectionProducts,
  diff,
  enqueueEvent,
  mediaAssets,
  productMedia,
  products,
  variants,
  writeAudit,
  type Tx,
} from '@uc/db';
import { and, asc, count, desc, eq, gt, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { decodeCursor, paginate } from '../../common/cursor';
import { AppError, Errors } from '../../common/errors';
import { safeFilename, sniffImageType } from '../../common/image-sniff';
import { iso, likePattern } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { StorageService } from '../../common/storage.service';
import { DbService } from '../../db/db.service';
import { assertTransition, checkVariantOptions } from './catalog-rules';

type ProductRow = typeof products.$inferSelect;
type VariantRow = typeof variants.$inferSelect;

const MAX_MEDIA_PER_PRODUCT = 50;

/** API path for admin image bytes; admin apps prefix their same-origin `/api` proxy. */
export const adminMediaUrl = (tenantId: string, mediaId: string) =>
  `/v1/admin/media/${mediaId}/content?tenantId=${tenantId}`;

function toVariant(v: VariantRow): Variant {
  return {
    id: v.id,
    sku: v.sku,
    barcode: v.barcode,
    title: v.title,
    optionValues: v.optionValues as Record<string, string>,
    status: v.status,
    position: v.position,
    version: v.version,
    createdAt: iso(v.createdAt),
    updatedAt: iso(v.updatedAt),
  };
}

function productSnapshot(p: ProductRow): Record<string, unknown> {
  return {
    title: p.title,
    slug: p.slug,
    status: p.status,
    description: p.description,
    brand: p.brand,
    categoryId: p.categoryId,
    tags: p.tags,
    options: p.options,
    attributes: p.attributes,
    seoTitle: p.seoTitle,
    seoDescription: p.seoDescription,
  };
}

@Injectable()
export class CatalogService {
  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
  ) {}

  // ---------------------------------------------------------------- shared helpers

  private audit(
    tx: Tx,
    auth: AuthState,
    ctx: TenantState,
    meta: RequestMeta,
    action: string,
    entityType: string,
    entityId: string,
    values: { oldValues?: Record<string, unknown> | null; newValues?: Record<string, unknown> | null },
  ) {
    return writeAudit(tx, {
      tenantId: ctx.tenantId,
      actorType: 'user',
      actorUserId: auth.userId,
      action,
      entityType,
      entityId,
      oldValues: values.oldValues ?? null,
      newValues: values.newValues ?? null,
      correlationId: meta.correlationId,
      ip: meta.ip,
    });
  }

  async findProduct(tx: Tx, ctx: TenantState, id: string, lock = false): Promise<ProductRow> {
    const q = tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, ctx.tenantId), eq(products.id, id)));
    const [row] = lock ? await q.for('update') : await q;
    if (!row) throw Errors.notFound('Product');
    return row;
  }

  private async assertCategory(tx: Tx, ctx: TenantState, categoryId: string | null | undefined) {
    if (!categoryId) return;
    const [c] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.tenantId, ctx.tenantId), eq(categories.id, categoryId)));
    if (!c) throw Errors.validation([{ path: 'categoryId', message: 'Unknown category' }]);
  }

  private async assertAttributes(tx: Tx, ctx: TenantState, values: AttributeValues) {
    const defs = await tx
      .select()
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.tenantId, ctx.tenantId));
    const issues = validateAttributes(values, defs);
    if (issues.length) throw Errors.validation(issues);
  }

  private assertProductType(ctx: TenantState, type: string) {
    if (type === 'jewellery' && !ctx.features.includes('jewellery'))
      throw Errors.featureNotEntitled('jewellery');
  }

  private async touch(tx: Tx, productId: string) {
    await tx.update(products).set({ updatedAt: new Date() }).where(eq(products.id, productId));
  }

  async detail(tx: Tx, ctx: TenantState, id: string): Promise<Product> {
    const p = await this.findProduct(tx, ctx, id);
    const variantRows = await tx
      .select()
      .from(variants)
      .where(and(eq(variants.tenantId, ctx.tenantId), eq(variants.productId, id)))
      .orderBy(asc(variants.position), asc(variants.createdAt));
    const media = await tx
      .select({ m: mediaAssets, position: productMedia.position })
      .from(productMedia)
      .innerJoin(mediaAssets, eq(mediaAssets.id, productMedia.mediaId))
      .where(and(eq(productMedia.tenantId, ctx.tenantId), eq(productMedia.productId, id)))
      .orderBy(asc(productMedia.position));
    const channelRows = await tx
      .select({ c: channels, pub: channelPublications })
      .from(channels)
      .leftJoin(
        channelPublications,
        and(eq(channelPublications.channelId, channels.id), eq(channelPublications.productId, id)),
      )
      .where(eq(channels.tenantId, ctx.tenantId))
      .orderBy(asc(channels.code));
    const coll = await tx
      .select({ id: collectionProducts.collectionId })
      .from(collectionProducts)
      .where(and(eq(collectionProducts.tenantId, ctx.tenantId), eq(collectionProducts.productId, id)));
    return {
      id: p.id,
      title: p.title,
      slug: p.slug,
      status: p.status,
      productType: p.productType,
      description: p.description,
      brand: p.brand,
      categoryId: p.categoryId,
      tags: p.tags,
      options: p.options as ProductOption[],
      attributes: p.attributes as AttributeValues,
      seo: { title: p.seoTitle, description: p.seoDescription },
      variants: variantRows.map(toVariant),
      media: media.map(({ m, position }) => ({
        id: m.id,
        url: adminMediaUrl(ctx.tenantId, m.id),
        filename: m.filename,
        contentType: m.contentType,
        byteSize: m.byteSize,
        altText: m.altText,
        position,
      })),
      publications: channelRows.map(({ c, pub }) => ({
        channelId: c.id,
        channelName: c.name,
        channelType: c.type,
        status: pub?.status ?? 'unpublished',
        publishedAt: pub?.status === 'published' && pub.publishedAt ? iso(pub.publishedAt) : null,
        version: pub?.version ?? 0,
      })),
      collectionIds: coll.map((c) => c.id),
      version: p.version,
      createdAt: iso(p.createdAt),
      updatedAt: iso(p.updatedAt),
    };
  }

  get(ctx: TenantState, id: string): Promise<Product> {
    return this.db.tenant(ctx.tenantId, (tx) => this.detail(tx, ctx, id));
  }

  // ---------------------------------------------------------------- list / search

  async list(ctx: TenantState, query: ProductListQuery): Promise<Page<ProductSummary>> {
    const descending = query.sort.startsWith('-');
    const field = query.sort.replace('-', '') as 'updatedAt' | 'title' | 'createdAt';
    const column =
      field === 'title' ? products.title : field === 'createdAt' ? products.createdAt : products.updatedAt;
    const cursor = decodeCursor(query.cursor);
    const where: (SQL | undefined)[] = [eq(products.tenantId, ctx.tenantId)];
    if (query.status) where.push(eq(products.status, query.status));
    if (query.productType) where.push(eq(products.productType, query.productType));
    if (query.categoryId) where.push(eq(products.categoryId, query.categoryId));
    // Correlated subqueries reference the outer row explicitly (ADR-014).
    if (query.collectionId) {
      where.push(
        sql`exists (select 1 from ${collectionProducts} cp where cp.product_id = "products"."id" and cp.collection_id = ${query.collectionId})`,
      );
    }
    if (query.channelId) {
      where.push(
        sql`exists (select 1 from ${channelPublications} pub where pub.product_id = "products"."id" and pub.channel_id = ${query.channelId} and pub.status = 'published')`,
      );
    }
    if (query.q) {
      const p = likePattern(query.q);
      where.push(
        or(
          ilike(products.title, p),
          ilike(products.brand, p),
          sql`exists (select 1 from ${variants} v where v.product_id = "products"."id" and (v.sku ilike ${p} or v.barcode ilike ${p}))`,
        ),
      );
    }
    if (cursor) {
      const value = field === 'title' ? String(cursor.sortValue) : new Date(String(cursor.sortValue));
      const cmp = descending ? lt : gt;
      where.push(or(cmp(column, value), and(eq(column, value), cmp(products.id, cursor.id))));
    }
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const rows = await tx
        .select({
          p: products,
          categoryName: categories.name,
          variantCount: sql<number>`(select count(*)::int from ${variants} v where v.product_id = "products"."id")`,
          skus: sql<
            string[]
          >`(select coalesce(array_agg(s.sku), '{}') from (select v.sku from ${variants} v where v.product_id = "products"."id" order by v.position, v.created_at limit 3) s)`,
          primaryMediaId: sql<
            string | null
          >`(select pm.media_id from ${productMedia} pm where pm.product_id = "products"."id" order by pm.position limit 1)`,
          publishedChannels: sql<number>`(select count(*)::int from ${channelPublications} pub where pub.product_id = "products"."id" and pub.status = 'published')`,
        })
        .from(products)
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .where(and(...where))
        .orderBy(...(descending ? [desc(column), desc(products.id)] : [asc(column), asc(products.id)]))
        .limit(query.limit + 1);
      const page = paginate(
        rows.map((r) => ({ id: r.p.id, r })),
        query.limit,
        ({ r }) => (field === 'title' ? r.p.title : r.p[field].toISOString()),
      );
      return {
        items: page.items.map(({ r }) => ({
          id: r.p.id,
          title: r.p.title,
          slug: r.p.slug,
          status: r.p.status,
          productType: r.p.productType,
          brand: r.p.brand,
          categoryName: r.categoryName,
          variantCount: r.variantCount,
          skus: r.skus,
          primaryMediaUrl: r.primaryMediaId ? adminMediaUrl(ctx.tenantId, r.primaryMediaId) : null,
          publishedChannels: r.publishedChannels,
          version: r.p.version,
          updatedAt: iso(r.p.updatedAt),
          createdAt: iso(r.p.createdAt),
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  // ---------------------------------------------------------------- products

  async create(
    auth: AuthState,
    ctx: TenantState,
    input: CreateProductRequest,
    meta: RequestMeta,
  ): Promise<Product> {
    this.assertProductType(ctx, input.productType);
    const slug = input.slug ?? slugify(input.title);
    if (!slug)
      throw Errors.validation([{ path: 'slug', message: 'Provide a slug (title has no usable characters)' }]);
    const options = input.options;
    if (options.length === 0 && input.variants.length > 1) {
      throw Errors.validation([
        { path: 'variants', message: 'Add options (e.g. Size) to create more than one variant' },
      ]);
    }
    const checked = input.variants.map((v, i) =>
      checkVariantOptions(options, v.optionValues, `variants.${i}.optionValues`),
    );
    if (new Set(checked.map((c) => c.key)).size !== checked.length) {
      throw Errors.validation([{ path: 'variants', message: 'Two variants have the same option values' }]);
    }
    if (new Set(input.variants.map((v) => v.sku.toLowerCase())).size !== input.variants.length) {
      throw Errors.validation([{ path: 'variants', message: 'Duplicate SKU within this product' }]);
    }
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await this.assertCategory(tx, ctx, input.categoryId);
      await this.assertAttributes(tx, ctx, input.attributes);
      const [row] = await tx
        .insert(products)
        .values({
          tenantId: ctx.tenantId,
          title: input.title,
          slug,
          productType: input.productType,
          description: input.description,
          brand: input.brand ?? null,
          categoryId: input.categoryId ?? null,
          tags: input.tags,
          options,
          attributes: input.attributes,
          seoTitle: input.seo?.title ?? null,
          seoDescription: input.seo?.description ?? null,
          createdBy: auth.userId,
        })
        .returning();
      await tx.insert(variants).values(
        input.variants.map((v, i) => ({
          tenantId: ctx.tenantId,
          productId: row!.id,
          sku: v.sku,
          barcode: v.barcode ?? null,
          title: v.title ?? Object.values(v.optionValues).join(' / '),
          optionValues: v.optionValues,
          optionKey: checked[i]!.key,
          status: v.status,
          position: i,
        })),
      );
      await this.audit(tx, auth, ctx, meta, 'product.created', 'product', row!.id, {
        newValues: { ...productSnapshot(row!), skus: input.variants.map((v) => v.sku) },
      });
      return this.detail(tx, ctx, row!.id);
    });
  }

  async update(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: UpdateProductRequest,
    meta: RequestMeta,
  ): Promise<Product> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const before = await this.findProduct(tx, ctx, id, true);
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      if (input.categoryId !== undefined) await this.assertCategory(tx, ctx, input.categoryId);
      if (input.attributes) await this.assertAttributes(tx, ctx, input.attributes);
      const variantRows = await tx.select().from(variants).where(eq(variants.productId, id));
      if (input.options) {
        for (const v of variantRows) {
          try {
            checkVariantOptions(input.options, v.optionValues as Record<string, string>);
          } catch {
            throw Errors.validation([
              { path: 'options', message: `Variant ${v.sku} would no longer match the options` },
            ]);
          }
        }
      }
      const nextStatus: ProductStatus = input.status ?? before.status;
      assertTransition(before.status, nextStatus);
      if (nextStatus === 'active' && !variantRows.some((v) => v.status === 'active')) {
        throw new AppError(
          409,
          'INVALID_STATE_TRANSITION',
          'A product needs at least one active variant to be active',
        );
      }
      const [after] = await tx
        .update(products)
        .set({
          title: input.title ?? before.title,
          slug: input.slug ?? before.slug,
          status: nextStatus,
          description: input.description ?? before.description,
          brand: input.brand === undefined ? before.brand : input.brand,
          categoryId: input.categoryId === undefined ? before.categoryId : input.categoryId,
          tags: input.tags ?? before.tags,
          options: input.options ?? before.options,
          attributes: input.attributes ?? before.attributes,
          seoTitle: input.seo?.title === undefined ? before.seoTitle : input.seo.title,
          seoDescription:
            input.seo?.description === undefined ? before.seoDescription : input.seo.description,
          archivedAt: nextStatus === 'archived' ? new Date() : null,
          version: before.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(products.id, id), eq(products.version, input.version)))
        .returning();
      if (!after) throw Errors.versionConflict();
      if (nextStatus === 'archived' && before.status !== 'archived') {
        // Archived products leave every channel.
        const published = await tx
          .update(channelPublications)
          .set({
            status: 'unpublished',
            unpublishedAt: new Date(),
            updatedAt: new Date(),
            version: sql`${channelPublications.version} + 1`,
          })
          .where(and(eq(channelPublications.productId, id), eq(channelPublications.status, 'published')))
          .returning({ channelId: channelPublications.channelId });
        for (const p of published) {
          await enqueueEvent(tx, {
            tenantId: ctx.tenantId,
            eventType: 'ProductUnpublished',
            aggregateType: 'product',
            aggregateId: id,
            aggregateVersion: after.version,
            correlationId: meta.correlationId,
            payload: { channelId: p.channelId, reason: 'archived' },
          });
        }
      }
      const action =
        before.status !== nextStatus
          ? `product.${nextStatus === 'active' ? 'activated' : nextStatus === 'archived' ? 'archived' : 'set_draft'}`
          : 'product.updated';
      await this.audit(
        tx,
        auth,
        ctx,
        meta,
        action,
        'product',
        id,
        diff(productSnapshot(before), productSnapshot(after)),
      );
      return this.detail(tx, ctx, id);
    });
  }

  // ---------------------------------------------------------------- variants

  async addVariant(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: CreateVariantRequest,
    meta: RequestMeta,
  ): Promise<Product> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const product = await this.findProduct(tx, ctx, id, true);
      if (product.status === 'archived')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', 'Archived products cannot get new variants');
      const { key } = checkVariantOptions(product.options as ProductOption[], input.optionValues);
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(variants)
        .where(eq(variants.productId, id));
      if (n >= 100)
        throw Errors.validation([{ path: 'variants', message: 'A product can have at most 100 variants' }]);
      const [row] = await tx
        .insert(variants)
        .values({
          tenantId: ctx.tenantId,
          productId: id,
          sku: input.sku,
          barcode: input.barcode ?? null,
          title: input.title ?? Object.values(input.optionValues).join(' / '),
          optionValues: input.optionValues,
          optionKey: key,
          status: input.status,
          position: n,
        })
        .returning();
      await this.touch(tx, id);
      await this.audit(tx, auth, ctx, meta, 'variant.created', 'variant', row!.id, {
        newValues: { productId: id, ...toVariant(row!) },
      });
      return this.detail(tx, ctx, id);
    });
  }

  async updateVariant(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    variantId: string,
    input: UpdateVariantRequest,
    meta: RequestMeta,
  ): Promise<Product> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const product = await this.findProduct(tx, ctx, id, true);
      const [before] = await tx
        .select()
        .from(variants)
        .where(
          and(eq(variants.tenantId, ctx.tenantId), eq(variants.productId, id), eq(variants.id, variantId)),
        );
      if (!before) throw Errors.notFound('Variant');
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      const optionValues = input.optionValues ?? (before.optionValues as Record<string, string>);
      const { key } = checkVariantOptions(product.options as ProductOption[], optionValues);
      if (input.status === 'inactive' && before.status === 'active' && product.status === 'active') {
        const [{ n } = { n: 0 }] = await tx
          .select({ n: count() })
          .from(variants)
          .where(and(eq(variants.productId, id), eq(variants.status, 'active')));
        if (n <= 1) {
          throw new AppError(
            409,
            'INVALID_STATE_TRANSITION',
            'An active product must keep at least one active variant',
          );
        }
      }
      const [after] = await tx
        .update(variants)
        .set({
          sku: input.sku ?? before.sku,
          barcode: input.barcode === undefined ? before.barcode : input.barcode,
          title: input.title ?? before.title,
          optionValues,
          optionKey: key,
          status: input.status ?? before.status,
          position: input.position ?? before.position,
          version: before.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(variants.id, variantId), eq(variants.version, input.version)))
        .returning();
      if (!after) throw Errors.versionConflict();
      await this.touch(tx, id);
      await this.audit(
        tx,
        auth,
        ctx,
        meta,
        'variant.updated',
        'variant',
        variantId,
        diff(toVariant(before), toVariant(after)),
      );
      return this.detail(tx, ctx, id);
    });
  }

  // ---------------------------------------------------------------- media

  async uploadMedia(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    file: { buffer: Buffer; originalname?: string; size: number } | undefined,
    meta: RequestMeta,
  ): Promise<Product> {
    if (!file?.buffer?.length)
      throw Errors.validation([{ path: 'file', message: 'Attach an image in the "file" field' }]);
    if (file.size > MAX_MEDIA_BYTES)
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Images must be 10 MB or smaller');
    const contentType = sniffImageType(file.buffer);
    if (!contentType) {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only JPEG, PNG, WebP or GIF images are accepted');
    }
    // Verify the product exists before writing to storage.
    await this.db.tenant(ctx.tenantId, (tx) => this.findProduct(tx, ctx, id));
    const mediaId = randomUUID();
    const key = StorageService.keyFor(ctx.tenantId, mediaId);
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    await this.storage.put(key, file.buffer, contentType, sha256);
    try {
      return await this.db.tenant(ctx.tenantId, async (tx) => {
        await this.findProduct(tx, ctx, id, true);
        const [{ n } = { n: 0 }] = await tx
          .select({ n: count() })
          .from(productMedia)
          .where(eq(productMedia.productId, id));
        if (n >= MAX_MEDIA_PER_PRODUCT)
          throw Errors.validation([{ path: 'file', message: 'A product can have at most 50 images' }]);
        const filename = safeFilename(file.originalname);
        await tx.insert(mediaAssets).values({
          id: mediaId,
          tenantId: ctx.tenantId,
          storageKey: key,
          filename,
          contentType,
          byteSize: file.size,
          sha256,
          createdBy: auth.userId,
        });
        await tx.insert(productMedia).values({ tenantId: ctx.tenantId, productId: id, mediaId, position: n });
        await this.touch(tx, id);
        await this.audit(tx, auth, ctx, meta, 'product.media_added', 'product', id, {
          newValues: { mediaId, filename, contentType, byteSize: file.size, sha256 },
        });
        return this.detail(tx, ctx, id);
      });
    } catch (error) {
      // Nothing references the object; remove it so storage does not accumulate orphans.
      await this.storage.delete(key).catch(() => undefined);
      throw error;
    }
  }

  async updateMedia(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: UpdateProductMediaRequest,
    meta: RequestMeta,
  ): Promise<Product> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await this.findProduct(tx, ctx, id, true);
      const current = await tx
        .select({ mediaId: productMedia.mediaId })
        .from(productMedia)
        .where(eq(productMedia.productId, id));
      const currentIds = new Set(current.map((c) => c.mediaId));
      const given = input.items.map((i) => i.mediaId);
      if (
        given.length !== currentIds.size ||
        new Set(given).size !== given.length ||
        !given.every((g) => currentIds.has(g))
      ) {
        throw Errors.validation([{ path: 'items', message: 'Send every current image exactly once' }]);
      }
      for (const [position, item] of input.items.entries()) {
        await tx
          .update(productMedia)
          .set({ position })
          .where(and(eq(productMedia.productId, id), eq(productMedia.mediaId, item.mediaId)));
        await tx
          .update(mediaAssets)
          .set({ altText: item.altText })
          .where(and(eq(mediaAssets.tenantId, ctx.tenantId), eq(mediaAssets.id, item.mediaId)));
      }
      await this.touch(tx, id);
      await this.audit(tx, auth, ctx, meta, 'product.media_updated', 'product', id, {
        newValues: { items: input.items },
      });
      return this.detail(tx, ctx, id);
    });
  }

  async removeMedia(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    mediaId: string,
    meta: RequestMeta,
  ): Promise<Product> {
    let storageKey: string | null = null;
    const result = await this.db.tenant(ctx.tenantId, async (tx) => {
      await this.findProduct(tx, ctx, id, true);
      const [link] = await tx
        .delete(productMedia)
        .where(
          and(
            eq(productMedia.tenantId, ctx.tenantId),
            eq(productMedia.productId, id),
            eq(productMedia.mediaId, mediaId),
          ),
        )
        .returning();
      if (!link) throw Errors.notFound('Image');
      const [asset] = await tx
        .delete(mediaAssets)
        .where(and(eq(mediaAssets.tenantId, ctx.tenantId), eq(mediaAssets.id, mediaId)))
        .returning();
      storageKey = asset?.storageKey ?? null;
      const rest = await tx
        .select()
        .from(productMedia)
        .where(eq(productMedia.productId, id))
        .orderBy(asc(productMedia.position));
      for (const [position, r] of rest.entries()) {
        await tx
          .update(productMedia)
          .set({ position })
          .where(and(eq(productMedia.productId, id), eq(productMedia.mediaId, r.mediaId)));
      }
      await this.touch(tx, id);
      await this.audit(tx, auth, ctx, meta, 'product.media_removed', 'product', id, {
        oldValues: { mediaId, filename: asset?.filename },
      });
      return this.detail(tx, ctx, id);
    });
    // After commit: the object is no longer referenced.
    if (storageKey) await this.storage.delete(storageKey).catch(() => undefined);
    return result;
  }

  async mediaContent(
    ctx: TenantState,
    mediaId: string,
  ): Promise<{ body: Readable; contentType: string; byteSize: number; sha256: string }> {
    const [asset] = await this.db.tenant(ctx.tenantId, (tx) =>
      tx
        .select()
        .from(mediaAssets)
        .where(and(eq(mediaAssets.tenantId, ctx.tenantId), eq(mediaAssets.id, mediaId))),
    );
    if (!asset) throw Errors.notFound('Image');
    return {
      body: await this.storage.get(asset.storageKey),
      contentType: asset.contentType,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
    };
  }

  // ---------------------------------------------------------------- publication

  private async publicationList(tx: Tx, ctx: TenantState, id: string): Promise<{ items: Publication[] }> {
    return { items: (await this.detail(tx, ctx, id)).publications };
  }

  async publish(auth: AuthState, ctx: TenantState, id: string, channelId: string, meta: RequestMeta) {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const product = await this.findProduct(tx, ctx, id, true);
      const [channel] = await tx
        .select()
        .from(channels)
        .where(and(eq(channels.tenantId, ctx.tenantId), eq(channels.id, channelId)));
      if (!channel) throw Errors.notFound('Channel');
      if (product.status !== 'active') {
        throw new AppError(409, 'INVALID_STATE_TRANSITION', 'Only active products can be published', {
          status: product.status,
        });
      }
      if (channel.status !== 'active')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', 'This channel is inactive');
      const [existing] = await tx
        .select()
        .from(channelPublications)
        .where(and(eq(channelPublications.productId, id), eq(channelPublications.channelId, channelId)));
      if (existing?.status === 'published') return this.publicationList(tx, ctx, id); // idempotent no-op
      const now = new Date();
      if (existing) {
        await tx
          .update(channelPublications)
          .set({
            status: 'published',
            publishedAt: now,
            publishedBy: auth.userId,
            version: existing.version + 1,
            updatedAt: now,
          })
          .where(eq(channelPublications.id, existing.id));
      } else {
        await tx.insert(channelPublications).values({
          tenantId: ctx.tenantId,
          productId: id,
          channelId,
          status: 'published',
          publishedAt: now,
          publishedBy: auth.userId,
        });
      }
      await enqueueEvent(tx, {
        tenantId: ctx.tenantId,
        eventType: 'ProductPublished',
        aggregateType: 'product',
        aggregateId: id,
        aggregateVersion: product.version,
        correlationId: meta.correlationId,
        payload: { channelId, slug: product.slug },
      });
      await this.audit(tx, auth, ctx, meta, 'product.published', 'product', id, {
        newValues: { channelId, channel: channel.code },
      });
      return this.publicationList(tx, ctx, id);
    });
  }

  async unpublish(auth: AuthState, ctx: TenantState, id: string, channelId: string, meta: RequestMeta) {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const product = await this.findProduct(tx, ctx, id, true);
      const [channel] = await tx
        .select()
        .from(channels)
        .where(and(eq(channels.tenantId, ctx.tenantId), eq(channels.id, channelId)));
      if (!channel) throw Errors.notFound('Channel');
      const [changed] = await tx
        .update(channelPublications)
        .set({
          status: 'unpublished',
          unpublishedAt: new Date(),
          updatedAt: new Date(),
          version: sql`${channelPublications.version} + 1`,
        })
        .where(
          and(
            eq(channelPublications.productId, id),
            eq(channelPublications.channelId, channelId),
            eq(channelPublications.status, 'published'),
          ),
        )
        .returning();
      if (changed) {
        await enqueueEvent(tx, {
          tenantId: ctx.tenantId,
          eventType: 'ProductUnpublished',
          aggregateType: 'product',
          aggregateId: id,
          aggregateVersion: product.version,
          correlationId: meta.correlationId,
          payload: { channelId, reason: 'manual' },
        });
        await this.audit(tx, auth, ctx, meta, 'product.unpublished', 'product', id, {
          oldValues: { channelId, channel: channel.code },
        });
      }
      return this.publicationList(tx, ctx, id);
    });
  }

  /** Used by imports: product ids for slugs within the tenant. */
  async idsBySlug(tx: Tx, ctx: TenantState, slugs: string[]) {
    if (slugs.length === 0) return new Map<string, ProductRow>();
    const rows = await tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, ctx.tenantId), inArray(products.slug, slugs)));
    return new Map(rows.map((r) => [r.slug, r]));
  }
}
