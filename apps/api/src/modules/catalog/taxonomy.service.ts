import { Injectable } from '@nestjs/common';
import {
  slugify,
  type AttributeDefinition,
  type Category,
  type Collection,
  type CollectionDetail,
  type CollectionListQuery,
  type CreateAttributeDefinitionRequest,
  type CreateCategoryRequest,
  type CreateCollectionRequest,
  type Page,
  type SetCollectionProductsRequest,
  type UpdateAttributeDefinitionRequest,
  type UpdateCategoryRequest,
  type UpdateCollectionRequest,
} from '@uc/contracts';
import {
  attributeDefinitions,
  categories,
  collectionProducts,
  collections,
  diff,
  products,
  writeAudit,
  type Tx,
} from '@uc/db';
import { and, asc, count, eq, gt, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { decodeCursor, paginate } from '../../common/cursor';
import { AppError, Errors } from '../../common/errors';
import { iso, likePattern } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';

type CategoryRow = typeof categories.$inferSelect;
type CollectionRow = typeof collections.$inferSelect;
type AttributeRow = typeof attributeDefinitions.$inferSelect;

const toAttribute = (a: AttributeRow): AttributeDefinition => ({
  id: a.id,
  key: a.key,
  label: a.label,
  type: a.type,
  options: a.options,
  required: a.required,
  version: a.version,
  createdAt: iso(a.createdAt),
  updatedAt: iso(a.updatedAt),
});

@Injectable()
export class TaxonomyService {
  constructor(private readonly db: DbService) {}

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

  // ---------------------------------------------------------------- categories

  private toCategory(c: CategoryRow, productCount: number): Category {
    return {
      id: c.id,
      parentId: c.parentId,
      name: c.name,
      slug: c.slug,
      description: c.description,
      position: c.position,
      productCount,
      version: c.version,
      createdAt: iso(c.createdAt),
      updatedAt: iso(c.updatedAt),
    };
  }

  private async categoryCounts(tx: Tx, ctx: TenantState) {
    const rows = await tx
      .select({ id: products.categoryId, n: count() })
      .from(products)
      .where(eq(products.tenantId, ctx.tenantId))
      .groupBy(products.categoryId);
    return new Map(rows.map((r) => [r.id, r.n]));
  }

  async listCategories(ctx: TenantState): Promise<{ items: Category[] }> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(categories)
        .where(eq(categories.tenantId, ctx.tenantId))
        .orderBy(asc(categories.position), asc(categories.name))
        .limit(1000);
      const counts = await this.categoryCounts(tx, ctx);
      // Depth-first order so the flat list renders as a tree.
      const byParent = new Map<string | null, CategoryRow[]>();
      for (const r of rows) byParent.set(r.parentId, [...(byParent.get(r.parentId) ?? []), r]);
      const ordered: CategoryRow[] = [];
      const walk = (parent: string | null) => {
        for (const c of byParent.get(parent) ?? []) {
          ordered.push(c);
          walk(c.id);
        }
      };
      walk(null);
      return { items: ordered.map((c) => this.toCategory(c, counts.get(c.id) ?? 0)) };
    });
  }

  private async findCategory(tx: Tx, ctx: TenantState, id: string): Promise<CategoryRow> {
    const [row] = await tx
      .select()
      .from(categories)
      .where(and(eq(categories.tenantId, ctx.tenantId), eq(categories.id, id)));
    if (!row) throw Errors.notFound('Category');
    return row;
  }

  /** Rejects moving a category under itself or one of its descendants. */
  private async assertNoCycle(tx: Tx, ctx: TenantState, id: string, parentId: string) {
    let cursor: string | null = parentId;
    for (let depth = 0; cursor && depth < 50; depth++) {
      if (cursor === id)
        throw Errors.validation([{ path: 'parentId', message: 'A category cannot be moved under itself' }]);
      cursor = (await this.findCategory(tx, ctx, cursor)).parentId;
    }
  }

  async createCategory(
    auth: AuthState,
    ctx: TenantState,
    input: CreateCategoryRequest,
    meta: RequestMeta,
  ): Promise<Category> {
    const slug = input.slug ?? slugify(input.name);
    if (!slug) throw Errors.validation([{ path: 'slug', message: 'Provide a slug' }]);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      if (input.parentId) await this.findCategory(tx, ctx, input.parentId);
      const [row] = await tx
        .insert(categories)
        .values({
          tenantId: ctx.tenantId,
          name: input.name,
          slug,
          parentId: input.parentId ?? null,
          description: input.description,
          position: input.position,
        })
        .returning();
      const category = this.toCategory(row!, 0);
      await this.audit(tx, auth, ctx, meta, 'category.created', 'category', row!.id, { newValues: category });
      return category;
    });
  }

  async updateCategory(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: UpdateCategoryRequest,
    meta: RequestMeta,
  ): Promise<Category> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const before = await this.findCategory(tx, ctx, id);
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      if (input.parentId) await this.assertNoCycle(tx, ctx, id, input.parentId);
      const { version, ...changes } = input;
      const [after] = await tx
        .update(categories)
        .set({ ...changes, version: version + 1, updatedAt: new Date() })
        .where(and(eq(categories.id, id), eq(categories.version, version)))
        .returning();
      if (!after) throw Errors.versionConflict();
      const counts = await this.categoryCounts(tx, ctx);
      await this.audit(
        tx,
        auth,
        ctx,
        meta,
        'category.updated',
        'category',
        id,
        diff(this.toCategory(before, 0), this.toCategory(after, 0)),
      );
      return this.toCategory(after, counts.get(id) ?? 0);
    });
  }

  async deleteCategory(auth: AuthState, ctx: TenantState, id: string, meta: RequestMeta): Promise<void> {
    await this.db.tenant(ctx.tenantId, async (tx) => {
      const row = await this.findCategory(tx, ctx, id);
      const [{ children } = { children: 0 }] = await tx
        .select({ children: count() })
        .from(categories)
        .where(eq(categories.parentId, id));
      const [{ used } = { used: 0 }] = await tx
        .select({ used: count() })
        .from(products)
        .where(eq(products.categoryId, id));
      if (children > 0 || used > 0) {
        throw new AppError(
          409,
          'CONFLICT',
          'Only empty categories can be deleted (move sub-categories and products first)',
          { children, products: used },
        );
      }
      await tx.delete(categories).where(eq(categories.id, id));
      await this.audit(tx, auth, ctx, meta, 'category.deleted', 'category', id, {
        oldValues: { name: row.name, slug: row.slug },
      });
    });
  }

  // ---------------------------------------------------------------- collections

  private toCollection(c: CollectionRow, productCount: number): Collection {
    return {
      id: c.id,
      title: c.title,
      slug: c.slug,
      description: c.description,
      status: c.status,
      productCount,
      version: c.version,
      createdAt: iso(c.createdAt),
      updatedAt: iso(c.updatedAt),
    };
  }

  async listCollections(ctx: TenantState, query: CollectionListQuery): Promise<Page<Collection>> {
    const cursor = decodeCursor(query.cursor);
    const where: (SQL | undefined)[] = [eq(collections.tenantId, ctx.tenantId)];
    if (query.q) where.push(ilike(collections.title, likePattern(query.q)));
    if (query.status) where.push(eq(collections.status, query.status));
    if (cursor) {
      const v = String(cursor.sortValue);
      where.push(or(gt(collections.title, v), and(eq(collections.title, v), gt(collections.id, cursor.id))));
    }
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const rows = await tx
        .select({
          c: collections,
          n: sql<number>`(select count(*)::int from ${collectionProducts} cp where cp.collection_id = "collections"."id")`,
        })
        .from(collections)
        .where(and(...where))
        .orderBy(asc(collections.title), asc(collections.id))
        .limit(query.limit + 1);
      const page = paginate(
        rows.map((r) => ({ id: r.c.id, r })),
        query.limit,
        ({ r }) => r.c.title,
      );
      return { items: page.items.map(({ r }) => this.toCollection(r.c, r.n)), nextCursor: page.nextCursor };
    });
  }

  private async collectionDetail(tx: Tx, ctx: TenantState, id: string): Promise<CollectionDetail> {
    const [c] = await tx
      .select()
      .from(collections)
      .where(and(eq(collections.tenantId, ctx.tenantId), eq(collections.id, id)));
    if (!c) throw Errors.notFound('Collection');
    const members = await tx
      .select({ id: products.id, title: products.title, status: products.status })
      .from(collectionProducts)
      .innerJoin(products, eq(products.id, collectionProducts.productId))
      .where(eq(collectionProducts.collectionId, id))
      .orderBy(asc(collectionProducts.position));
    return { ...this.toCollection(c, members.length), products: members };
  }

  getCollection(ctx: TenantState, id: string): Promise<CollectionDetail> {
    return this.db.tenant(ctx.tenantId, (tx) => this.collectionDetail(tx, ctx, id));
  }

  async createCollection(
    auth: AuthState,
    ctx: TenantState,
    input: CreateCollectionRequest,
    meta: RequestMeta,
  ): Promise<Collection> {
    const slug = input.slug ?? slugify(input.title);
    if (!slug) throw Errors.validation([{ path: 'slug', message: 'Provide a slug' }]);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .insert(collections)
        .values({
          tenantId: ctx.tenantId,
          title: input.title,
          slug,
          description: input.description,
          status: input.status,
        })
        .returning();
      const collection = this.toCollection(row!, 0);
      await this.audit(tx, auth, ctx, meta, 'collection.created', 'collection', row!.id, {
        newValues: collection,
      });
      return collection;
    });
  }

  private async lockCollection(
    tx: Tx,
    ctx: TenantState,
    id: string,
    version: number,
  ): Promise<CollectionRow> {
    const [row] = await tx
      .select()
      .from(collections)
      .where(and(eq(collections.tenantId, ctx.tenantId), eq(collections.id, id)))
      .for('update');
    if (!row) throw Errors.notFound('Collection');
    if (row.version !== version) throw Errors.versionConflict(row.version);
    return row;
  }

  async updateCollection(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: UpdateCollectionRequest,
    meta: RequestMeta,
  ): Promise<CollectionDetail> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const before = await this.lockCollection(tx, ctx, id, input.version);
      const { version, ...changes } = input;
      const [after] = await tx
        .update(collections)
        .set({ ...changes, version: version + 1, updatedAt: new Date() })
        .where(eq(collections.id, id))
        .returning();
      await this.audit(
        tx,
        auth,
        ctx,
        meta,
        'collection.updated',
        'collection',
        id,
        diff(this.toCollection(before, 0), this.toCollection(after!, 0)),
      );
      return this.collectionDetail(tx, ctx, id);
    });
  }

  async setCollectionProducts(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: SetCollectionProductsRequest,
    meta: RequestMeta,
  ): Promise<CollectionDetail> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const before = await this.lockCollection(tx, ctx, id, input.version);
      if (input.productIds.length) {
        const found = await tx
          .select({ id: products.id })
          .from(products)
          .where(and(eq(products.tenantId, ctx.tenantId), inArray(products.id, input.productIds)));
        if (found.length !== input.productIds.length)
          throw Errors.validation([{ path: 'productIds', message: 'Unknown product' }]);
      }
      const old = await tx
        .select({ id: collectionProducts.productId })
        .from(collectionProducts)
        .where(eq(collectionProducts.collectionId, id));
      await tx.delete(collectionProducts).where(eq(collectionProducts.collectionId, id));
      if (input.productIds.length) {
        await tx.insert(collectionProducts).values(
          input.productIds.map((productId, position) => ({
            tenantId: ctx.tenantId,
            collectionId: id,
            productId,
            position,
          })),
        );
      }
      await tx
        .update(collections)
        .set({ version: before.version + 1, updatedAt: new Date() })
        .where(eq(collections.id, id));
      await this.audit(tx, auth, ctx, meta, 'collection.products_set', 'collection', id, {
        oldValues: { productIds: old.map((o) => o.id) },
        newValues: { productIds: input.productIds },
      });
      return this.collectionDetail(tx, ctx, id);
    });
  }

  // ---------------------------------------------------------------- attribute definitions

  async listAttributes(ctx: TenantState): Promise<{ items: AttributeDefinition[] }> {
    const rows = await this.db.tenant(ctx.tenantId, (tx) =>
      tx
        .select()
        .from(attributeDefinitions)
        .where(eq(attributeDefinitions.tenantId, ctx.tenantId))
        .orderBy(asc(attributeDefinitions.label)),
    );
    return { items: rows.map(toAttribute) };
  }

  async createAttribute(
    auth: AuthState,
    ctx: TenantState,
    input: CreateAttributeDefinitionRequest,
    meta: RequestMeta,
  ): Promise<AttributeDefinition> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .insert(attributeDefinitions)
        .values({ tenantId: ctx.tenantId, ...input })
        .returning();
      await this.audit(tx, auth, ctx, meta, 'attribute.created', 'attribute_definition', row!.id, {
        newValues: toAttribute(row!),
      });
      return toAttribute(row!);
    });
  }

  async updateAttribute(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: UpdateAttributeDefinitionRequest,
    meta: RequestMeta,
  ): Promise<AttributeDefinition> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [before] = await tx
        .select()
        .from(attributeDefinitions)
        .where(and(eq(attributeDefinitions.tenantId, ctx.tenantId), eq(attributeDefinitions.id, id)))
        .for('update');
      if (!before) throw Errors.notFound('Attribute');
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      if (input.options && before.type !== 'select')
        throw Errors.validation([{ path: 'options', message: 'Only select attributes have options' }]);
      if (input.options && input.options.length === 0)
        throw Errors.validation([{ path: 'options', message: 'Keep at least one option' }]);
      if (input.options) {
        // Removing an option that products still use would silently invalidate them.
        const removed = before.options.filter((o: string) => !input.options!.includes(o));
        if (removed.length) {
          const [{ n } = { n: 0 }] = await tx
            .select({ n: count() })
            .from(products)
            .where(
              and(
                eq(products.tenantId, ctx.tenantId),
                inArray(sql`${products.attributes} ->> ${before.key}`, removed),
              ),
            );
          if (n > 0)
            throw new AppError(409, 'CONFLICT', `${n} product(s) still use the removed option(s)`, {
              removed,
            });
        }
      }
      const { version, ...changes } = input;
      const [after] = await tx
        .update(attributeDefinitions)
        .set({ ...changes, version: version + 1, updatedAt: new Date() })
        .where(eq(attributeDefinitions.id, id))
        .returning();
      await this.audit(
        tx,
        auth,
        ctx,
        meta,
        'attribute.updated',
        'attribute_definition',
        id,
        diff(toAttribute(before), toAttribute(after!)),
      );
      return toAttribute(after!);
    });
  }
}
