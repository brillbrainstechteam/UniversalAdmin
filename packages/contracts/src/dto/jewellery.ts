import { DecimalString, PageQuery, Reason, Timestamp, Uuid, Version, pageOf } from '../common';
import { WEIGHT_UNITS } from '../jewellery-math';
import { z } from '../z';

export const Metal = z.enum(['gold', 'silver', 'platinum', 'palladium', 'other']);
export type Metal = z.infer<typeof Metal>;
export const BillingBasis = z.enum(['gross', 'net', 'fine', 'piece']);
export const QtyUnit = z.enum(['piece', 'pair', 'set']);
export const ComponentKind = z.enum(['diamond', 'gemstone', 'pearl', 'metal', 'other']);

/** Raw measurement as entered/imported. Converted exactly to canonical grams; the raw value is kept. */
export const WeightInput = z
  .object({
    value: z.string().regex(/^\d{1,14}(\.\d{1,6})?$/, 'Use a non-negative number with up to 6 decimals, e.g. 12.345'),
    unit: z.enum(WEIGHT_UNITS).default('g'),
  })
  .openapi('WeightInput');
export type WeightInput = z.infer<typeof WeightInput>;

export const Grams = z.string().openapi({ description: 'Canonical grams, decimal string with 6 dp' });

export const MeasurementCheck = z
  .object({
    code: z.enum(['GROSS_MISMATCH', 'STONE_COMPONENT_MISMATCH', 'FINE_DEVIATION', 'PURITY_UNCONFIRMED', 'NET_EXCEEDS_GROSS']),
    severity: z.enum(['warning', 'info']),
    message: z.string(),
  })
  .openapi('MeasurementCheck');
export type MeasurementCheck = z.infer<typeof MeasurementCheck>;

// ---------------------------------------------------------------- settings & purities

export const JewellerySettings = z
  .object({
    weightToleranceG: Grams,
    fineScale: z.number().int(),
    huidFormat: z.enum(['bis_6_alnum', 'free_text']),
    version: Version,
    updatedAt: Timestamp,
  })
  .openapi('JewellerySettings');
export type JewellerySettings = z.infer<typeof JewellerySettings>;

export const UpdateJewellerySettingsRequest = z
  .object({
    version: Version,
    weightToleranceG: DecimalString.refine((v) => !v.startsWith('-'), 'Tolerance cannot be negative').optional(),
    fineScale: z.number().int().min(0).max(6).optional(),
    huidFormat: z.enum(['bis_6_alnum', 'free_text']).optional(),
  })
  .openapi('UpdateJewellerySettingsRequest');
export type UpdateJewellerySettingsRequest = z.infer<typeof UpdateJewellerySettingsRequest>;

const Fineness = z
  .string()
  .regex(/^(0\.\d{1,6}|1(\.0{1,6})?)$/, 'Fineness is a fraction like 0.916 (max 6 decimals, ≤ 1)')
  .refine((v) => /[1-9]/.test(v), 'Fineness must be greater than 0');

export const PurityDefinition = z
  .object({
    id: Uuid,
    metal: Metal,
    code: z.string(),
    label: z.string(),
    fineness: z.string(),
    status: z.enum(['active', 'inactive']),
    source: z.enum(['platform_default', 'merchant']),
    confirmedAt: Timestamp.nullable(),
    version: Version,
    updatedAt: Timestamp,
  })
  .openapi('PurityDefinition');
export type PurityDefinition = z.infer<typeof PurityDefinition>;
export const PurityList = z.object({ items: z.array(PurityDefinition) }).openapi('PurityList');

export const CreatePurityRequest = z
  .object({
    metal: Metal,
    code: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9.]+$/, 'Letters, digits and dots only'),
    label: z.string().trim().min(1).max(60),
    fineness: Fineness,
  })
  .openapi('CreatePurityRequest');
export type CreatePurityRequest = z.infer<typeof CreatePurityRequest>;

export const UpdatePurityRequest = z
  .object({
    version: Version,
    label: z.string().trim().min(1).max(60).optional(),
    fineness: Fineness.optional(),
    status: z.enum(['active', 'inactive']).optional(),
    /** Merchant confirms the fineness (required for platform defaults before relying on computed fine weight). */
    confirm: z.boolean().optional(),
  })
  .openapi('UpdatePurityRequest');
export type UpdatePurityRequest = z.infer<typeof UpdatePurityRequest>;

export const PurityRef = z.object({ id: Uuid, code: z.string(), label: z.string(), fineness: z.string(), confirmed: z.boolean() });

// ---------------------------------------------------------------- components

export const ComponentInput = z
  .object({
    kind: ComponentKind,
    description: z.string().trim().max(200).default(''),
    shape: z.string().trim().max(40).nullable().optional(),
    grade: z.string().trim().max(60).nullable().optional(),
    count: z.number().int().min(1).max(10_000).default(1),
    weight: WeightInput,
    /** Required for metal components (multi-metal pieces), forbidden otherwise. */
    purityId: Uuid.nullable().optional(),
    certificate: z.string().trim().max(120).nullable().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.kind === 'metal' && !c.purityId) ctx.addIssue({ code: 'custom', path: ['purityId'], message: 'Metal components need a purity' });
    if (c.kind !== 'metal' && c.purityId) ctx.addIssue({ code: 'custom', path: ['purityId'], message: 'Only metal components have a purity' });
    if (c.kind === 'metal' && c.weight.unit === 'ct') ctx.addIssue({ code: 'custom', path: ['weight', 'unit'], message: 'Carats are for stones only' });
  })
  .openapi('ComponentInput');
export type ComponentInput = z.infer<typeof ComponentInput>;

export const Component = z
  .object({
    id: Uuid,
    kind: ComponentKind,
    description: z.string(),
    shape: z.string().nullable(),
    grade: z.string().nullable(),
    count: z.number().int(),
    weightG: Grams,
    caratWeight: z.string().nullable(),
    purity: PurityRef.nullable(),
    certificate: z.string().nullable(),
    raw: z.record(z.unknown()),
  })
  .openapi('JewelleryComponent');
export type Component = z.infer<typeof Component>;

// ---------------------------------------------------------------- variant spec

export const JewellerySpec = z
  .object({
    id: Uuid,
    variantId: Uuid,
    metal: Metal,
    purity: PurityRef,
    colour: z.string().nullable(),
    grossG: Grams.nullable(),
    netG: Grams.nullable(),
    stoneG: Grams.nullable(),
    fineG: Grams.nullable(),
    fineSource: z.enum(['computed', 'entered']).nullable(),
    billingBasis: BillingBasis,
    qtyUnit: QtyUnit,
    piecesPerUnit: z.number().int(),
    components: z.array(Component),
    raw: z.record(z.unknown()),
    checks: z.array(MeasurementCheck),
    version: Version,
    updatedAt: Timestamp,
  })
  .openapi('JewellerySpec');
export type JewellerySpec = z.infer<typeof JewellerySpec>;

export const PutJewellerySpecRequest = z
  .object({
    /** Required when a spec already exists (optimistic locking); omit to create. */
    version: Version.optional(),
    purityId: Uuid,
    colour: z.string().trim().max(40).nullable().optional(),
    gross: WeightInput.nullable().optional(),
    net: WeightInput.nullable().optional(),
    stone: WeightInput.nullable().optional(),
    /** Entered fine weight (e.g. from a hallmark certificate); omit/null to compute from net × fineness. */
    fine: WeightInput.nullable().optional(),
    billingBasis: BillingBasis,
    qtyUnit: QtyUnit.default('piece'),
    piecesPerUnit: z.number().int().min(1).max(1000).default(1),
    components: z.array(ComponentInput).max(50).default([]),
  })
  .openapi('PutJewellerySpecRequest');
export type PutJewellerySpecRequest = z.infer<typeof PutJewellerySpecRequest>;

// ---------------------------------------------------------------- serialized items

export const Certificate = z
  .object({
    lab: z.string().trim().min(1).max(60),
    number: z.string().trim().min(1).max(80),
    issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional(),
  })
  .openapi('Certificate');

export const SerialItemStatus = z.enum(['pending_review', 'active', 'retired']);
export const SerialTag = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'Tag may contain letters, digits, . _ / -');

export const SerialItem = z
  .object({
    id: Uuid,
    variantId: Uuid,
    productId: Uuid,
    productTitle: z.string(),
    sku: z.string(),
    serialTag: z.string(),
    huid: z.string().nullable(),
    metal: Metal,
    purity: PurityRef,
    grossG: Grams,
    netG: Grams,
    stoneG: Grams,
    fineG: Grams,
    fineSource: z.enum(['computed', 'entered']),
    fineFormula: z.record(z.unknown()).nullable(),
    pieces: z.number().int(),
    status: SerialItemStatus,
    /** Physical stock state (Phase 04); pieces enter stock through an inventory receipt. */
    stockState: z.enum(['not_received', 'in_stock', 'reserved', 'committed', 'in_transit', 'written_off']),
    location: z.object({ id: Uuid, code: z.string(), name: z.string() }).nullable(),
    weightExceptionReason: z.string().nullable(),
    review: z.object({ by: z.string().nullable(), at: Timestamp, note: z.string().nullable() }).nullable(),
    certificates: z.array(Certificate),
    components: z.array(Component),
    raw: z.record(z.unknown()),
    checks: z.array(MeasurementCheck),
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('SerialItem');
export type SerialItem = z.infer<typeof SerialItem>;
export const SerialItemPage = pageOf(SerialItem.omit({ components: true, raw: true, fineFormula: true })).openapi('SerialItemPage');

const ItemFields = {
  serialTag: SerialTag,
  huid: z.string().trim().max(32).nullable().optional(),
  /** Defaults to the variant spec's purity. */
  purityId: Uuid.optional(),
  gross: WeightInput,
  net: WeightInput,
  stone: WeightInput.optional(),
  fine: WeightInput.nullable().optional(),
  pieces: z.number().int().min(1).max(1000).optional(),
  certificates: z.array(Certificate).max(10).default([]),
  components: z.array(ComponentInput).max(50).default([]),
  /** Required when net exceeds gross; the item then needs review by another user. */
  weightExceptionReason: Reason.nullable().optional(),
};

export const SerialItemInput = z.object(ItemFields).openapi('SerialItemInput');
export type SerialItemInput = z.infer<typeof SerialItemInput>;

export const CreateSerialItemRequest = z.object({ variantId: Uuid, ...ItemFields }).openapi('CreateSerialItemRequest');
export type CreateSerialItemRequest = z.infer<typeof CreateSerialItemRequest>;

export const MAX_BULK_ITEMS = 200;
export const BulkSerialItemsRequest = z
  .object({
    variantId: Uuid,
    /** true = validate and compute only; nothing is written. */
    dryRun: z.boolean().default(false),
    items: z.array(SerialItemInput).min(1).max(MAX_BULK_ITEMS),
  })
  .openapi('BulkSerialItemsRequest');
export type BulkSerialItemsRequest = z.infer<typeof BulkSerialItemsRequest>;

export const BulkSerialItemsResponse = z
  .object({
    dryRun: z.boolean(),
    created: z.number().int(),
    rows: z.array(
      z.object({
        index: z.number().int(),
        serialTag: z.string(),
        grossG: Grams,
        netG: Grams,
        stoneG: Grams,
        fineG: Grams,
        status: SerialItemStatus,
        checks: z.array(MeasurementCheck),
        id: Uuid.nullable(),
      }),
    ),
  })
  .openapi('BulkSerialItemsResponse');
export type BulkSerialItemsResponse = z.infer<typeof BulkSerialItemsResponse>;

export const UpdateSerialItemRequest = z
  .object({
    version: Version,
    serialTag: SerialTag.optional(),
    huid: z.string().trim().max(32).nullable().optional(),
    purityId: Uuid.optional(),
    gross: WeightInput.optional(),
    net: WeightInput.optional(),
    stone: WeightInput.optional(),
    /** null = switch back to computed fine weight. */
    fine: WeightInput.nullable().optional(),
    pieces: z.number().int().min(1).max(1000).optional(),
    certificates: z.array(Certificate).max(10).optional(),
    components: z.array(ComponentInput).max(50).optional(),
    status: z.enum(['active', 'retired']).optional(),
    weightExceptionReason: Reason.nullable().optional(),
    /** Required when changing measurements or HUID of an active item (edit policy, audited). */
    reason: Reason.optional(),
  })
  .openapi('UpdateSerialItemRequest');
export type UpdateSerialItemRequest = z.infer<typeof UpdateSerialItemRequest>;

export const ReviewSerialItemRequest = z
  .object({ version: Version, decision: z.enum(['approve', 'reject']), note: Reason })
  .openapi('ReviewSerialItemRequest');
export type ReviewSerialItemRequest = z.infer<typeof ReviewSerialItemRequest>;

export const SerialItemListQuery = PageQuery.extend({
  q: z.string().trim().max(100).optional(),
  status: SerialItemStatus.optional(),
  productId: Uuid.optional(),
  variantId: Uuid.optional(),
  metal: Metal.optional(),
  purityId: Uuid.optional(),
  stockState: z.enum(['not_received', 'in_stock', 'reserved', 'committed', 'in_transit', 'written_off']).optional(),
  locationId: Uuid.optional(),
  sort: z.enum(['-createdAt', 'createdAt', 'serialTag', '-grossG', 'grossG']).default('-createdAt'),
});
export type SerialItemListQuery = z.infer<typeof SerialItemListQuery>;

export const VariantParams = z.object({ id: Uuid, variantId: Uuid });

/** Jewellery data attached to a product detail (null for non-jewellery products). */
export const ProductJewellery = z
  .object({
    specs: z.array(JewellerySpec),
    serialItemCounts: z.record(z.number().int()),
  })
  .openapi('ProductJewellery');
export type ProductJewellery = z.infer<typeof ProductJewellery>;

/** Public storefront view of a variant's design spec (no internal ids). */
export const StorefrontJewellery = z
  .object({
    metal: Metal,
    purity: z.string(),
    colour: z.string().nullable(),
    grossG: Grams.nullable(),
    netG: Grams.nullable(),
    stoneG: Grams.nullable(),
    qtyUnit: QtyUnit,
    piecesPerUnit: z.number().int(),
  })
  .openapi('StorefrontJewellery');
