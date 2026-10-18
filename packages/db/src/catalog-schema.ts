import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { channels, tenants, users } from './schema';

// Phase 02 catalog. Product ≠ variant ≠ (Phase 03) serialized item; no prices or stock here.
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });
const id = () => uuid('id').primaryKey().defaultRandom();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });
const version = () => integer('version').notNull().default(0);
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();

export const categories = pgTable(
  'categories',
  {
    id: id(),
    tenantId: tenantId(),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description').notNull().default(''),
    position: integer('position').notNull().default(0),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('categories_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('categories_tenant_slug_uq').on(t.tenantId, t.slug),
    foreignKey({ columns: [t.tenantId, t.parentId], foreignColumns: [t.tenantId, t.id] }),
    check('categories_parent_ck', sql`${t.parentId} is null or ${t.parentId} <> ${t.id}`),
  ],
);

export const attributeDefinitions = pgTable(
  'attribute_definitions',
  {
    id: id(),
    tenantId: tenantId(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: text('type', { enum: ['text', 'number', 'boolean', 'select'] }).notNull(),
    options: text('options')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    required: boolean('required').notNull().default(false),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('attribute_definitions_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('attribute_definitions_tenant_key_uq').on(t.tenantId, t.key),
    check('attribute_definitions_type_ck', sql`${t.type} in ('text','number','boolean','select')`),
  ],
);

export const products = pgTable(
  'products',
  {
    id: id(),
    tenantId: tenantId(),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    status: text('status', { enum: ['draft', 'active', 'archived'] })
      .notNull()
      .default('draft'),
    productType: text('product_type', { enum: ['standard', 'jewellery'] })
      .notNull()
      .default('standard'),
    description: text('description').notNull().default(''),
    brand: text('brand'),
    categoryId: uuid('category_id'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** [{ name, values[] }] — option axes; variant option values must use these. */
    options: jsonb('options')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Values keyed by attribute_definitions.key; numbers stored as decimal strings. */
    attributes: jsonb('attributes')
      .notNull()
      .default(sql`'{}'::jsonb`),
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    archivedAt: ts('archived_at'),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('products_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('products_tenant_slug_uq').on(t.tenantId, t.slug),
    foreignKey({ columns: [t.tenantId, t.categoryId], foreignColumns: [categories.tenantId, categories.id] }),
    index('products_tenant_status_idx').on(t.tenantId, t.status, t.updatedAt.desc()),
    index('products_title_trgm_idx').using('gin', t.title.op('gin_trgm_ops')),
    check('products_status_ck', sql`${t.status} in ('draft','active','archived')`),
    check('products_type_ck', sql`${t.productType} in ('standard','jewellery')`),
  ],
);

export const variants = pgTable(
  'variants',
  {
    id: id(),
    tenantId: tenantId(),
    productId: uuid('product_id').notNull(),
    sku: text('sku').notNull(),
    barcode: text('barcode'),
    title: text('title').notNull().default(''),
    optionValues: jsonb('option_values')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Canonical "name=value|name=value" (lower-cased, sorted) — unique per product. */
    optionKey: text('option_key').notNull().default(''),
    status: text('status', { enum: ['active', 'inactive'] })
      .notNull()
      .default('active'),
    position: integer('position').notNull().default(0),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('variants_tenant_id_uq').on(t.tenantId, t.id),
    // SKUs are case-insensitively unique within a tenant (same SKU may exist in another tenant).
    uniqueIndex('variants_tenant_sku_uq').on(t.tenantId, sql`lower(${t.sku})`),
    uniqueIndex('variants_tenant_barcode_uq')
      .on(t.tenantId, t.barcode)
      .where(sql`${t.barcode} is not null`),
    uniqueIndex('variants_product_option_key_uq').on(t.productId, t.optionKey),
    foreignKey({
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }).onDelete('cascade'),
    index('variants_sku_trgm_idx').using('gin', t.sku.op('gin_trgm_ops')),
    check('variants_status_ck', sql`${t.status} in ('active','inactive')`),
    check('variants_sku_ck', sql`length(${t.sku}) between 1 and 64`),
  ],
);

export const collections = pgTable(
  'collections',
  {
    id: id(),
    tenantId: tenantId(),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    description: text('description').notNull().default(''),
    status: text('status', { enum: ['active', 'inactive'] })
      .notNull()
      .default('active'),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('collections_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('collections_tenant_slug_uq').on(t.tenantId, t.slug),
    check('collections_status_ck', sql`${t.status} in ('active','inactive')`),
  ],
);

export const collectionProducts = pgTable(
  'collection_products',
  {
    tenantId: uuid('tenant_id').notNull(),
    collectionId: uuid('collection_id').notNull(),
    productId: uuid('product_id').notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.collectionId, t.productId] }),
    foreignKey({
      columns: [t.tenantId, t.collectionId],
      foreignColumns: [collections.tenantId, collections.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }).onDelete('cascade'),
    index('collection_products_product_idx').on(t.tenantId, t.productId),
  ],
);

export const mediaAssets = pgTable(
  'media_assets',
  {
    id: id(),
    tenantId: tenantId(),
    storageKey: text('storage_key').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    altText: text('alt_text').notNull().default(''),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('media_assets_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('media_assets_storage_key_uq').on(t.storageKey),
    check(
      'media_assets_type_ck',
      sql`${t.contentType} in ('image/jpeg','image/png','image/webp','image/gif')`,
    ),
    check('media_assets_size_ck', sql`${t.byteSize} > 0`),
  ],
);

export const productMedia = pgTable(
  'product_media',
  {
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    mediaId: uuid('media_id').notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.mediaId] }),
    foreignKey({
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.mediaId],
      foreignColumns: [mediaAssets.tenantId, mediaAssets.id],
    }).onDelete('cascade'),
    index('product_media_media_idx').on(t.tenantId, t.mediaId),
  ],
);

export const channelPublications = pgTable(
  'channel_publications',
  {
    id: id(),
    tenantId: tenantId(),
    productId: uuid('product_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    status: text('status', { enum: ['published', 'unpublished'] }).notNull(),
    publishedAt: ts('published_at'),
    publishedBy: uuid('published_by').references(() => users.id, { onDelete: 'set null' }),
    unpublishedAt: ts('unpublished_at'),
    version: version(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('channel_publications_product_channel_uq').on(t.productId, t.channelId),
    index('channel_publications_channel_idx').on(t.tenantId, t.channelId, t.status),
    foreignKey({
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.channelId],
      foreignColumns: [channels.tenantId, channels.id],
    }).onDelete('cascade'),
    check('channel_publications_status_ck', sql`${t.status} in ('published','unpublished')`),
  ],
);

export const savedViews = pgTable(
  'saved_views',
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    resource: text('resource', { enum: ['products'] }).notNull(),
    name: text('name').notNull(),
    filters: jsonb('filters').notNull(),
    isShared: boolean('is_shared').notNull().default(false),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('saved_views_owner_name_uq').on(t.tenantId, t.userId, t.resource, t.name),
    check('saved_views_resource_ck', sql`${t.resource} in ('products')`),
  ],
);

export const catalogImportBatches = pgTable(
  'catalog_import_batches',
  {
    id: id(),
    tenantId: tenantId(),
    status: text('status', { enum: ['previewed', 'committed', 'discarded'] })
      .notNull()
      .default('previewed'),
    filename: text('filename').notNull(),
    rowCount: integer('row_count').notNull(),
    validCount: integer('valid_count').notNull(),
    errorCount: integer('error_count').notNull(),
    /** Normalised rows with per-row errors (raw source values preserved alongside). */
    rows: jsonb('rows').notNull(),
    summary: jsonb('summary'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    committedBy: uuid('committed_by').references(() => users.id, { onDelete: 'set null' }),
    committedAt: ts('committed_at'),
    version: version(),
    createdAt: createdAt(),
  },
  (t) => [
    index('catalog_import_batches_tenant_idx').on(t.tenantId, t.createdAt.desc()),
    check('catalog_import_batches_status_ck', sql`${t.status} in ('previewed','committed','discarded')`),
  ],
);

export const CATALOG_RLS_TABLES = [
  'categories',
  'attribute_definitions',
  'products',
  'variants',
  'collections',
  'collection_products',
  'media_assets',
  'product_media',
  'channel_publications',
  'saved_views',
  'catalog_import_batches',
] as const;
