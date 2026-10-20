import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { variants } from './catalog-schema';
import { locations, tenants, users } from './schema';

// Phase 03 jewellery measurements. All weights are canonical grams NUMERIC(20,6) — never floats.
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });
const id = () => uuid('id').primaryKey().defaultRandom();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });
const version = () => integer('version').notNull().default(0);
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();
const grams = (name: string) => numeric(name, { precision: 20, scale: 6 });

export const METALS = ['gold', 'silver', 'platinum', 'palladium', 'other'] as const;

export const jewellerySettings = pgTable(
  'jewellery_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    weightToleranceG: grams('weight_tolerance_g').notNull().default('0.010000'),
    fineScale: integer('fine_scale').notNull().default(3),
    huidFormat: text('huid_format', { enum: ['bis_6_alnum', 'free_text'] })
      .notNull()
      .default('bis_6_alnum'),
    version: version(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('jewellery_settings_scale_ck', sql`${t.fineScale} between 0 and 6`),
    check('jewellery_settings_tolerance_ck', sql`${t.weightToleranceG} >= 0`),
    check('jewellery_settings_huid_ck', sql`${t.huidFormat} in ('bis_6_alnum','free_text')`),
  ],
);

export const purityDefinitions = pgTable(
  'purity_definitions',
  {
    id: id(),
    tenantId: tenantId(),
    metal: text('metal', { enum: METALS }).notNull(),
    code: text('code').notNull(),
    label: text('label').notNull(),
    /** Fraction of pure metal, e.g. 0.916000 for 22K. Merchant-confirmed (defaults are only a starting point). */
    fineness: numeric('fineness', { precision: 7, scale: 6 }).notNull(),
    status: text('status', { enum: ['active', 'inactive'] })
      .notNull()
      .default('active'),
    source: text('source', { enum: ['platform_default', 'merchant'] })
      .notNull()
      .default('merchant'),
    confirmedBy: uuid('confirmed_by').references(() => users.id, { onDelete: 'set null' }),
    confirmedAt: ts('confirmed_at'),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('purity_definitions_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('purity_definitions_tenant_code_uq').on(t.tenantId, t.metal, t.code),
    check('purity_definitions_fineness_ck', sql`${t.fineness} > 0 and ${t.fineness} <= 1`),
    check('purity_definitions_metal_ck', sql`${t.metal} in ('gold','silver','platinum','palladium','other')`),
    check('purity_definitions_status_ck', sql`${t.status} in ('active','inactive')`),
  ],
);

export const jewellerySpecs = pgTable(
  'jewellery_specs',
  {
    id: id(),
    tenantId: tenantId(),
    variantId: uuid('variant_id').notNull(),
    metal: text('metal', { enum: METALS }).notNull(),
    purityId: uuid('purity_id').notNull(),
    colour: text('colour'),
    /** Nominal (design) weights; actual per-piece weights live on serial items. */
    grossG: grams('gross_g'),
    netG: grams('net_g'),
    stoneG: grams('stone_g'),
    fineG: grams('fine_g'),
    fineSource: text('fine_source', { enum: ['computed', 'entered'] }),
    billingBasis: text('billing_basis', { enum: ['gross', 'net', 'fine', 'piece'] }).notNull(),
    qtyUnit: text('qty_unit', { enum: ['piece', 'pair', 'set'] })
      .notNull()
      .default('piece'),
    piecesPerUnit: integer('pieces_per_unit').notNull().default(1),
    /** Exactly what was entered/imported (value + unit), kept apart from canonical grams. */
    raw: jsonb('raw')
      .notNull()
      .default(sql`'{}'::jsonb`),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('jewellery_specs_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('jewellery_specs_variant_uq').on(t.tenantId, t.variantId),
    foreignKey({
      columns: [t.tenantId, t.variantId],
      foreignColumns: [variants.tenantId, variants.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.purityId],
      foreignColumns: [purityDefinitions.tenantId, purityDefinitions.id],
    }),
    check(
      'jewellery_specs_weights_ck',
      sql`coalesce(${t.grossG},0) >= 0 and coalesce(${t.netG},0) >= 0 and coalesce(${t.stoneG},0) >= 0 and coalesce(${t.fineG},0) >= 0`,
    ),
    check('jewellery_specs_basis_ck', sql`${t.billingBasis} in ('gross','net','fine','piece')`),
    check('jewellery_specs_unit_ck', sql`${t.qtyUnit} in ('piece','pair','set')`),
    check('jewellery_specs_pieces_ck', sql`${t.piecesPerUnit} between 1 and 1000`),
  ],
);

export const serialItems = pgTable(
  'serial_items',
  {
    id: id(),
    tenantId: tenantId(),
    variantId: uuid('variant_id').notNull(),
    serialTag: text('serial_tag').notNull(),
    huid: text('huid'),
    metal: text('metal', { enum: METALS }).notNull(),
    purityId: uuid('purity_id').notNull(),
    grossG: grams('gross_g').notNull(),
    netG: grams('net_g').notNull(),
    stoneG: grams('stone_g').notNull().default('0'),
    fineG: grams('fine_g').notNull(),
    fineSource: text('fine_source', { enum: ['computed', 'entered'] }).notNull(),
    /** Formula id + inputs used when computed (provenance). */
    fineFormula: jsonb('fine_formula'),
    pieces: integer('pieces').notNull().default(1),
    /** Phase 04: where the piece is and its stock state (lifecycle status is separate). */
    locationId: uuid('location_id'),
    stockState: text('stock_state', {
      enum: ['not_received', 'in_stock', 'reserved', 'committed', 'in_transit', 'written_off', 'shipped'],
    })
      .notNull()
      .default('not_received'),
    status: text('status', { enum: ['pending_review', 'active', 'retired'] })
      .notNull()
      .default('active'),
    weightExceptionReason: text('weight_exception_reason'),
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: ts('reviewed_at'),
    reviewNote: text('review_note'),
    certificates: jsonb('certificates')
      .notNull()
      .default(sql`'[]'::jsonb`),
    raw: jsonb('raw')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('serial_items_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('serial_items_tenant_tag_uq').on(t.tenantId, sql`lower(${t.serialTag})`),
    // A HUID identifies one physical article: never shared within a merchant.
    uniqueIndex('serial_items_tenant_huid_uq')
      .on(t.tenantId, t.huid)
      .where(sql`${t.huid} is not null`),
    index('serial_items_variant_idx').on(t.tenantId, t.variantId),
    foreignKey({
      columns: [t.tenantId, t.variantId],
      foreignColumns: [variants.tenantId, variants.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.purityId],
      foreignColumns: [purityDefinitions.tenantId, purityDefinitions.id],
    }),
    check(
      'serial_items_weights_ck',
      sql`${t.grossG} >= 0 and ${t.netG} >= 0 and ${t.stoneG} >= 0 and ${t.fineG} >= 0`,
    ),
    // net > gross only with a recorded exception reason (reviewed via maker-checker).
    check(
      'serial_items_net_gross_ck',
      sql`${t.netG} <= ${t.grossG} or ${t.weightExceptionReason} is not null`,
    ),
    check('serial_items_pieces_ck', sql`${t.pieces} between 1 and 1000`),
    check('serial_items_status_ck', sql`${t.status} in ('pending_review','active','retired')`),
    foreignKey({ columns: [t.tenantId, t.locationId], foreignColumns: [locations.tenantId, locations.id] }),
    check(
      'serial_items_stock_state_ck',
      sql`${t.stockState} in ('not_received','in_stock','reserved','committed','in_transit','written_off','shipped')`,
    ),
    check(
      'serial_items_located_ck',
      sql`${t.stockState} in ('not_received','written_off') or ${t.locationId} is not null`,
    ),
    check('serial_items_huid_upper_ck', sql`${t.huid} is null or ${t.huid} = upper(${t.huid})`),
  ],
);

export const jewelleryComponents = pgTable(
  'jewellery_components',
  {
    id: id(),
    tenantId: tenantId(),
    specId: uuid('spec_id'),
    itemId: uuid('item_id'),
    kind: text('kind', { enum: ['diamond', 'gemstone', 'pearl', 'metal', 'other'] }).notNull(),
    description: text('description').notNull().default(''),
    shape: text('shape'),
    grade: text('grade'),
    count: integer('count').notNull().default(1),
    weightG: grams('weight_g').notNull(),
    metal: text('metal', { enum: METALS }),
    purityId: uuid('purity_id'),
    certificate: text('certificate'),
    position: integer('position').notNull().default(0),
    raw: jsonb('raw')
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.specId],
      foreignColumns: [jewellerySpecs.tenantId, jewellerySpecs.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.itemId],
      foreignColumns: [serialItems.tenantId, serialItems.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.purityId],
      foreignColumns: [purityDefinitions.tenantId, purityDefinitions.id],
    }),
    index('jewellery_components_spec_idx').on(t.specId),
    index('jewellery_components_item_idx').on(t.itemId),
    check('jewellery_components_owner_ck', sql`(${t.specId} is null) <> (${t.itemId} is null)`),
    check('jewellery_components_kind_ck', sql`${t.kind} in ('diamond','gemstone','pearl','metal','other')`),
    check('jewellery_components_count_ck', sql`${t.count} between 1 and 10000`),
    check('jewellery_components_weight_ck', sql`${t.weightG} >= 0`),
    check('jewellery_components_metal_ck', sql`(${t.kind} = 'metal') = (${t.purityId} is not null)`),
  ],
);

export const JEWELLERY_RLS_TABLES = [
  'jewellery_settings',
  'purity_definitions',
  'jewellery_specs',
  'serial_items',
  'jewellery_components',
] as const;
