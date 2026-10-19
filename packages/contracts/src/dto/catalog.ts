import { DecimalString, PageQuery, Timestamp, Uuid, Version, pageOf } from '../common';
import { z } from '../z';
import { ProductJewellery, StorefrontJewellery } from './jewellery';

// ---------------------------------------------------------------- primitives

export const Slug = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lower-case letters, digits and single hyphens');

/** Derives a URL slug from free text (ASCII-folds accents). */
export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export const Sku = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'SKU may contain letters, digits, . _ / - and must start alphanumeric');
export const Barcode = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z-]{4,48}$/, 'Barcode must be 4-48 letters, digits or hyphens');

export const ProductStatus = z.enum(['draft', 'active', 'archived']);
export type ProductStatus = z.infer<typeof ProductStatus>;
export const ProductType = z.enum(['standard', 'jewellery']);
export type ProductType = z.infer<typeof ProductType>;

const OptionName = z.string().trim().min(1).max(40);
const OptionValue = z.string().trim().min(1).max(60);

export const ProductOption = z
  .object({
    name: OptionName,
    values: z
      .array(OptionValue)
      .min(1)
      .max(100)
      .refine((v) => new Set(v.map((x) => x.toLowerCase())).size === v.length, 'Option values must be unique'),
  })
  .openapi('ProductOption');
export type ProductOption = z.infer<typeof ProductOption>;

const ProductOptions = z
  .array(ProductOption)
  .max(3, 'At most 3 options')
  .refine((o) => new Set(o.map((x) => x.name.toLowerCase())).size === o.length, 'Option names must be unique');

/** Attribute values: text/select as string, number as decimal string (never float), boolean as boolean. */
export const AttributeValues = z.record(z.string().max(60), z.union([z.string().max(2000), z.boolean()]));
export type AttributeValues = z.infer<typeof AttributeValues>;

export const Seo = z
  .object({
    title: z.string().trim().max(70).nullable().optional(),
    description: z.string().trim().max(320).nullable().optional(),
  })
  .openapi('Seo');

const Tags = z.array(z.string().trim().min(1).max(40)).max(50);

// ---------------------------------------------------------------- variants

export const VariantInput = z
  .object({
    sku: Sku,
    barcode: Barcode.nullable().optional(),
    title: z.string().trim().max(120).optional(),
    optionValues: z.record(OptionName, OptionValue).default({}),
    status: z.enum(['active', 'inactive']).default('active'),
  })
  .openapi('VariantInput');
export type VariantInput = z.infer<typeof VariantInput>;

export const Variant = z
  .object({
    id: Uuid,
    sku: z.string(),
    barcode: z.string().nullable(),
    title: z.string(),
    optionValues: z.record(z.string()),
    status: z.enum(['active', 'inactive']),
    position: z.number().int(),
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('Variant');
export type Variant = z.infer<typeof Variant>;

export const CreateVariantRequest = VariantInput.openapi('CreateVariantRequest');
export type CreateVariantRequest = z.infer<typeof CreateVariantRequest>;

export const UpdateVariantRequest = z
  .object({
    version: Version,
    sku: Sku.optional(),
    barcode: Barcode.nullable().optional(),
    title: z.string().trim().max(120).optional(),
    optionValues: z.record(OptionName, OptionValue).optional(),
    status: z.enum(['active', 'inactive']).optional(),
    position: z.number().int().min(0).max(10_000).optional(),
  })
  .openapi('UpdateVariantRequest');
export type UpdateVariantRequest = z.infer<typeof UpdateVariantRequest>;

export const VariantIdParams = z.object({ id: Uuid, variantId: Uuid });

// ---------------------------------------------------------------- products

export const ProductMedia = z
  .object({
    id: Uuid,
    url: z.string(),
    filename: z.string(),
    contentType: z.string(),
    byteSize: z.number().int(),
    altText: z.string(),
    position: z.number().int(),
  })
  .openapi('ProductMedia');
export type ProductMedia = z.infer<typeof ProductMedia>;

export const Publication = z
  .object({
    channelId: Uuid,
    channelName: z.string(),
    channelType: z.string(),
    status: z.enum(['published', 'unpublished']),
    publishedAt: Timestamp.nullable(),
    version: Version,
  })
  .openapi('Publication');
export type Publication = z.infer<typeof Publication>;

export const Product = z
  .object({
    id: Uuid,
    title: z.string(),
    slug: z.string(),
    status: ProductStatus,
    productType: ProductType,
    description: z.string(),
    brand: z.string().nullable(),
    categoryId: Uuid.nullable(),
    tags: z.array(z.string()),
    options: z.array(ProductOption),
    attributes: AttributeValues,
    seo: z.object({ title: z.string().nullable(), description: z.string().nullable() }),
    variants: z.array(Variant),
    media: z.array(ProductMedia),
    publications: z.array(Publication),
    collectionIds: z.array(Uuid),
    /** Present for jewellery products: per-variant specs and serial item counts. */
    jewellery: ProductJewellery.nullable(),
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('Product');
export type Product = z.infer<typeof Product>;

export const ProductSummary = z
  .object({
    id: Uuid,
    title: z.string(),
    slug: z.string(),
    status: ProductStatus,
    productType: ProductType,
    brand: z.string().nullable(),
    categoryName: z.string().nullable(),
    variantCount: z.number().int(),
    skus: z.array(z.string()),
    primaryMediaUrl: z.string().nullable(),
    publishedChannels: z.number().int(),
    version: Version,
    updatedAt: Timestamp,
    createdAt: Timestamp,
  })
  .openapi('ProductSummary');
export type ProductSummary = z.infer<typeof ProductSummary>;
export const ProductPage = pageOf(ProductSummary).openapi('ProductPage');

export const PRODUCT_SORTS = ['-updatedAt', 'updatedAt', 'title', '-title', '-createdAt', 'createdAt'] as const;
export const ProductFilters = z.object({
  q: z.string().trim().max(100).optional(),
  status: ProductStatus.optional(),
  productType: ProductType.optional(),
  categoryId: Uuid.optional(),
  collectionId: Uuid.optional(),
  channelId: Uuid.optional(),
  sort: z.enum(PRODUCT_SORTS).default('-updatedAt'),
});
export type ProductFilters = z.infer<typeof ProductFilters>;
export const ProductListQuery = PageQuery.merge(ProductFilters);
export type ProductListQuery = z.infer<typeof ProductListQuery>;

export const CreateProductRequest = z
  .object({
    title: z.string().trim().min(1).max(200),
    slug: Slug.optional(),
    productType: ProductType.default('standard'),
    description: z.string().max(20_000).default(''),
    brand: z.string().trim().max(120).nullable().optional(),
    categoryId: Uuid.nullable().optional(),
    tags: Tags.default([]),
    options: ProductOptions.default([]),
    attributes: AttributeValues.default({}),
    seo: Seo.optional(),
    variants: z.array(VariantInput).min(1, 'Add at least one variant (SKU)').max(100),
  })
  .openapi('CreateProductRequest');
export type CreateProductRequest = z.infer<typeof CreateProductRequest>;

export const UpdateProductRequest = z
  .object({
    version: Version,
    title: z.string().trim().min(1).max(200).optional(),
    slug: Slug.optional(),
    status: ProductStatus.optional(),
    description: z.string().max(20_000).optional(),
    brand: z.string().trim().max(120).nullable().optional(),
    categoryId: Uuid.nullable().optional(),
    tags: Tags.optional(),
    options: ProductOptions.optional(),
    attributes: AttributeValues.optional(),
    seo: Seo.optional(),
  })
  .openapi('UpdateProductRequest');
export type UpdateProductRequest = z.infer<typeof UpdateProductRequest>;

export const UpdateProductMediaRequest = z
  .object({
    /** Full ordered gallery; must contain exactly the product's current media ids. */
    items: z.array(z.object({ mediaId: Uuid, altText: z.string().trim().max(250) })).max(50),
  })
  .openapi('UpdateProductMediaRequest');
export type UpdateProductMediaRequest = z.infer<typeof UpdateProductMediaRequest>;

export const MediaParams = z.object({ id: Uuid, mediaId: Uuid });
export const ChannelParams = z.object({ id: Uuid, channelId: Uuid });
export const PublicationList = z.object({ items: z.array(Publication) }).openapi('PublicationList');

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

// ---------------------------------------------------------------- categories

export const Category = z
  .object({
    id: Uuid,
    parentId: Uuid.nullable(),
    name: z.string(),
    slug: z.string(),
    description: z.string(),
    position: z.number().int(),
    productCount: z.number().int(),
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('Category');
export type Category = z.infer<typeof Category>;
export const CategoryList = z.object({ items: z.array(Category) }).openapi('CategoryList');

export const CreateCategoryRequest = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: Slug.optional(),
    parentId: Uuid.nullable().optional(),
    description: z.string().max(5000).default(''),
    position: z.number().int().min(0).max(10_000).default(0),
  })
  .openapi('CreateCategoryRequest');
export type CreateCategoryRequest = z.infer<typeof CreateCategoryRequest>;

export const UpdateCategoryRequest = z
  .object({
    version: Version,
    name: z.string().trim().min(1).max(120).optional(),
    slug: Slug.optional(),
    parentId: Uuid.nullable().optional(),
    description: z.string().max(5000).optional(),
    position: z.number().int().min(0).max(10_000).optional(),
  })
  .openapi('UpdateCategoryRequest');
export type UpdateCategoryRequest = z.infer<typeof UpdateCategoryRequest>;

// ---------------------------------------------------------------- collections

export const Collection = z
  .object({
    id: Uuid,
    title: z.string(),
    slug: z.string(),
    description: z.string(),
    status: z.enum(['active', 'inactive']),
    productCount: z.number().int(),
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('Collection');
export type Collection = z.infer<typeof Collection>;
export const CollectionPage = pageOf(Collection).openapi('CollectionPage');
export const CollectionListQuery = PageQuery.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
export type CollectionListQuery = z.infer<typeof CollectionListQuery>;

export const CollectionDetail = Collection.extend({
  products: z.array(z.object({ id: Uuid, title: z.string(), status: ProductStatus })),
}).openapi('CollectionDetail');
export type CollectionDetail = z.infer<typeof CollectionDetail>;

export const CreateCollectionRequest = z
  .object({
    title: z.string().trim().min(1).max(120),
    slug: Slug.optional(),
    description: z.string().max(5000).default(''),
    status: z.enum(['active', 'inactive']).default('active'),
  })
  .openapi('CreateCollectionRequest');
export type CreateCollectionRequest = z.infer<typeof CreateCollectionRequest>;

export const UpdateCollectionRequest = z
  .object({
    version: Version,
    title: z.string().trim().min(1).max(120).optional(),
    slug: Slug.optional(),
    description: z.string().max(5000).optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .openapi('UpdateCollectionRequest');
export type UpdateCollectionRequest = z.infer<typeof UpdateCollectionRequest>;

export const SetCollectionProductsRequest = z
  .object({
    version: Version,
    productIds: z
      .array(Uuid)
      .max(500)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate products'),
  })
  .openapi('SetCollectionProductsRequest');
export type SetCollectionProductsRequest = z.infer<typeof SetCollectionProductsRequest>;

// ---------------------------------------------------------------- attribute definitions

export const AttributeType = z.enum(['text', 'number', 'boolean', 'select']);
export const AttributeDefinition = z
  .object({
    id: Uuid,
    key: z.string(),
    label: z.string(),
    type: AttributeType,
    options: z.array(z.string()),
    required: z.boolean(),
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('AttributeDefinition');
export type AttributeDefinition = z.infer<typeof AttributeDefinition>;
export const AttributeDefinitionList = z
  .object({ items: z.array(AttributeDefinition) })
  .openapi('AttributeDefinitionList');

const AttributeKey = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[a-z][a-z0-9_]*$/, 'Use lower_snake_case starting with a letter');
const SelectOptions = z
  .array(z.string().trim().min(1).max(60))
  .max(200)
  .refine((o) => new Set(o).size === o.length, 'Options must be unique');

export const CreateAttributeDefinitionRequest = z
  .object({
    key: AttributeKey,
    label: z.string().trim().min(1).max(80),
    type: AttributeType,
    options: SelectOptions.default([]),
    required: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'select' && v.options.length === 0)
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Select attributes need at least one option' });
    if (v.type !== 'select' && v.options.length > 0)
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Only select attributes have options' });
  })
  .openapi('CreateAttributeDefinitionRequest');
export type CreateAttributeDefinitionRequest = z.infer<typeof CreateAttributeDefinitionRequest>;

export const UpdateAttributeDefinitionRequest = z
  .object({
    version: Version,
    label: z.string().trim().min(1).max(80).optional(),
    options: SelectOptions.optional(),
    required: z.boolean().optional(),
  })
  .openapi('UpdateAttributeDefinitionRequest');
export type UpdateAttributeDefinitionRequest = z.infer<typeof UpdateAttributeDefinitionRequest>;

/** Validates attribute values against definitions; returns issues keyed by `attributes.<key>`. */
export function validateAttributes(
  values: AttributeValues,
  definitions: { key: string; type: string; options: string[]; required: boolean; label: string }[],
): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const byKey = new Map(definitions.map((d) => [d.key, d]));
  for (const [key, value] of Object.entries(values)) {
    const def = byKey.get(key);
    const path = `attributes.${key}`;
    if (!def) {
      issues.push({ path, message: `Unknown attribute "${key}"` });
      continue;
    }
    if (def.type === 'boolean' && typeof value !== 'boolean') issues.push({ path, message: `${def.label} must be true or false` });
    if (def.type !== 'boolean' && typeof value !== 'string') issues.push({ path, message: `${def.label} must be text` });
    if (def.type === 'number' && typeof value === 'string' && !DecimalString.safeParse(value).success)
      issues.push({ path, message: `${def.label} must be a decimal number written as text, e.g. "18.5"` });
    if (def.type === 'select' && typeof value === 'string' && !def.options.includes(value))
      issues.push({ path, message: `${def.label} must be one of: ${def.options.join(', ')}` });
  }
  for (const def of definitions) {
    const v = values[def.key];
    if (def.required && (v === undefined || v === '')) issues.push({ path: `attributes.${def.key}`, message: `${def.label} is required` });
  }
  return issues;
}

/** Canonical option key used for per-product uniqueness of variant option combinations. */
export function optionKey(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([k, v]) => `${k.trim().toLowerCase()}=${v.trim().toLowerCase()}`)
    .sort()
    .join('|');
}

// ---------------------------------------------------------------- saved views

export const SavedView = z
  .object({
    id: Uuid,
    resource: z.literal('products'),
    name: z.string(),
    filters: ProductFilters,
    isShared: z.boolean(),
    isOwn: z.boolean(),
    ownerEmail: z.string(),
    version: Version,
    updatedAt: Timestamp,
  })
  .openapi('SavedView');
export type SavedView = z.infer<typeof SavedView>;
export const SavedViewList = z.object({ items: z.array(SavedView) }).openapi('SavedViewList');

export const CreateSavedViewRequest = z
  .object({
    resource: z.literal('products'),
    name: z.string().trim().min(1).max(60),
    filters: ProductFilters,
    isShared: z.boolean().default(false),
  })
  .openapi('CreateSavedViewRequest');
export type CreateSavedViewRequest = z.infer<typeof CreateSavedViewRequest>;

export const UpdateSavedViewRequest = z
  .object({
    version: Version,
    name: z.string().trim().min(1).max(60).optional(),
    filters: ProductFilters.optional(),
    isShared: z.boolean().optional(),
  })
  .openapi('UpdateSavedViewRequest');
export type UpdateSavedViewRequest = z.infer<typeof UpdateSavedViewRequest>;

// ---------------------------------------------------------------- CSV import

export const IMPORT_COLUMNS = [
  'handle',
  'title',
  'status',
  'product_type',
  'brand',
  'category_slug',
  'tags',
  'description',
  'option1_name',
  'option1_value',
  'option2_name',
  'option2_value',
  'sku',
  'barcode',
  'variant_title',
] as const;
export const MAX_IMPORT_ROWS = 1000;

export const CreateImportRequest = z
  .object({
    filename: z.string().trim().min(1).max(200),
    /** UTF-8 CSV text, header row required. */
    content: z.string().min(1).max(2_000_000),
  })
  .openapi('CreateImportRequest');
export type CreateImportRequest = z.infer<typeof CreateImportRequest>;

export const ImportRow = z
  .object({
    line: z.number().int(),
    handle: z.string(),
    sku: z.string(),
    action: z.enum(['create_product', 'update_product', 'error']),
    variantAction: z.enum(['create', 'update', 'none']),
    errors: z.array(z.object({ field: z.string(), message: z.string() })),
    /** Raw source values exactly as uploaded (provenance). */
    raw: z.record(z.string()),
  })
  .openapi('ImportRow');
export type ImportRow = z.infer<typeof ImportRow>;

export const ImportBatch = z
  .object({
    id: Uuid,
    status: z.enum(['previewed', 'committed', 'discarded']),
    filename: z.string(),
    rowCount: z.number().int(),
    validCount: z.number().int(),
    errorCount: z.number().int(),
    rows: z.array(ImportRow),
    summary: z
      .object({ productsCreated: z.number().int(), productsUpdated: z.number().int(), variantsCreated: z.number().int(), variantsUpdated: z.number().int() })
      .nullable(),
    createdAt: Timestamp,
    committedAt: Timestamp.nullable(),
  })
  .openapi('ImportBatch');
export type ImportBatch = z.infer<typeof ImportBatch>;

export const ImportBatchSummary = ImportBatch.omit({ rows: true }).openapi('ImportBatchSummary');
export const ImportBatchPage = pageOf(ImportBatchSummary).openapi('ImportBatchPage');

// ---------------------------------------------------------------- storefront catalog

export const StorefrontImage = z.object({ url: z.string(), altText: z.string() }).openapi('StorefrontImage');

export const StorefrontProductSummary = z
  .object({
    slug: z.string(),
    title: z.string(),
    brand: z.string().nullable(),
    productType: ProductType,
    image: StorefrontImage.nullable(),
  })
  .openapi('StorefrontProductSummary');
export const StorefrontProductPage = pageOf(StorefrontProductSummary).openapi('StorefrontProductPage');

export const StorefrontProduct = z
  .object({
    slug: z.string(),
    title: z.string(),
    description: z.string(),
    brand: z.string().nullable(),
    productType: ProductType,
    category: z.object({ slug: z.string(), name: z.string() }).nullable(),
    tags: z.array(z.string()),
    options: z.array(ProductOption),
    attributes: AttributeValues,
    seo: z.object({ title: z.string(), description: z.string().nullable() }),
    images: z.array(StorefrontImage),
    variants: z.array(
      z.object({
        /** Used to add the variant to a cart (Phase 07). */
        id: Uuid,
        sku: z.string(),
        title: z.string(),
        optionValues: z.record(z.string()),
        jewellery: StorefrontJewellery.nullable(),
      }),
    ),
  })
  .openapi('StorefrontProduct');
export type StorefrontProduct = z.infer<typeof StorefrontProduct>;

export const StorefrontProductQuery = PageQuery.extend({
  q: z.string().trim().max(100).optional(),
  category: Slug.optional(),
  collection: Slug.optional(),
});
export type StorefrontProductQuery = z.infer<typeof StorefrontProductQuery>;

export const StorefrontCategoryList = z
  .object({ items: z.array(z.object({ slug: z.string(), name: z.string(), parentSlug: z.string().nullable() })) })
  .openapi('StorefrontCategoryList');
export const StorefrontCollection = z
  .object({ slug: z.string(), title: z.string(), description: z.string() })
  .openapi('StorefrontCollection');
export const SlugParam = z.object({ slug: Slug });
