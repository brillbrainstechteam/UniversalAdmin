import { Injectable } from '@nestjs/common';
import {
  Barcode,
  IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  ProductStatus,
  ProductType,
  Sku,
  Slug,
  optionKey,
  type CreateImportRequest,
  type ImportBatch,
  type ImportRow,
  type Page,
  type ProductOption,
} from '@uc/contracts';
import { catalogImportBatches, categories, products, variants, writeAudit, type Tx } from '@uc/db';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { parseCsv } from '../../common/csv';
import { decodeCursor, paginate } from '../../common/cursor';
import { AppError, Errors } from '../../common/errors';
import { iso } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';
import { assertTransition } from './catalog-rules';
import { assertPlanCapacity } from '../launch/plans.service';

type Raw = Record<string, string>;
type ProductRow = typeof products.$inferSelect;
type BatchRow = typeof catalogImportBatches.$inferSelect;

interface PlannedVariant {
  sku: string;
  barcode: string | null;
  title: string;
  optionValues: Record<string, string>;
  key: string;
  existingId: string | null;
}
interface Group {
  handle: string;
  lines: number[];
  existing: ProductRow | null;
  fields: {
    title: string | null;
    status: ProductStatus | null;
    productType: ProductType | null;
    brand: string | null;
    categoryId: string | null;
    tags: string[] | null;
    description: string | null;
  };
  options: ProductOption[];
  variants: PlannedVariant[];
}
interface Plan {
  rows: ImportRow[];
  groups: Group[]; // only fully valid groups
}

const REQUIRED = ['handle', 'sku'];

/**
 * Merchant CSV catalog import (not an ERP connector — Phase 05). One row per variant, grouped by `handle`.
 * Preview validates without writing products; commit re-validates against current data and applies all valid
 * product groups in one transaction. A product group with any invalid row is skipped as a whole.
 */
@Injectable()
export class ImportService {
  constructor(private readonly db: DbService) {}

  private toBatch(b: BatchRow): ImportBatch {
    return {
      id: b.id,
      status: b.status,
      filename: b.filename,
      rowCount: b.rowCount,
      validCount: b.validCount,
      errorCount: b.errorCount,
      rows: b.rows as ImportRow[],
      summary: (b.summary as ImportBatch['summary']) ?? null,
      createdAt: iso(b.createdAt),
      committedAt: b.committedAt ? iso(b.committedAt) : null,
    };
  }

  private parse(content: string): { line: number; raw: Raw }[] {
    let table: { line: number; cells: string[] }[];
    try {
      table = parseCsv(content);
    } catch (error) {
      throw Errors.validation([{ path: 'content', message: (error as Error).message }]);
    }
    const [header, ...data] = table;
    if (!header) throw Errors.validation([{ path: 'content', message: 'The file is empty' }]);
    const columns = header.cells.map((c) => c.trim().toLowerCase());
    const unknown = columns.filter((c) => !(IMPORT_COLUMNS as readonly string[]).includes(c));
    if (unknown.length) {
      throw Errors.validation([
        {
          path: 'content',
          message: `Unknown columns: ${unknown.join(', ')}. Allowed: ${IMPORT_COLUMNS.join(', ')}`,
        },
      ]);
    }
    const missing = REQUIRED.filter((r) => !columns.includes(r));
    if (missing.length)
      throw Errors.validation([
        { path: 'content', message: `Missing required columns: ${missing.join(', ')}` },
      ]);
    if (new Set(columns).size !== columns.length)
      throw Errors.validation([{ path: 'content', message: 'Duplicate column names' }]);
    if (data.length === 0)
      throw Errors.validation([{ path: 'content', message: 'The file has a header but no rows' }]);
    if (data.length > MAX_IMPORT_ROWS) {
      throw new AppError(
        413,
        'PAYLOAD_TOO_LARGE',
        `At most ${MAX_IMPORT_ROWS} rows per import (got ${data.length})`,
      );
    }
    return data.map((r) => ({
      line: r.line,
      raw: Object.fromEntries(columns.map((c, i) => [c, (r.cells[i] ?? '').trim()])),
    }));
  }

  /** Validates parsed rows against current tenant data; pure read. */
  private async analyze(tx: Tx, ctx: TenantState, input: { line: number; raw: Raw }[]): Promise<Plan> {
    const rowErrors = new Map<number, { field: string; message: string }[]>();
    const err = (line: number, field: string, message: string) =>
      rowErrors.set(line, [...(rowErrors.get(line) ?? []), { field, message }]);

    const handles = [...new Set(input.map((r) => r.raw.handle ?? '').filter(Boolean))];
    const existingProducts = handles.length
      ? await tx
          .select()
          .from(products)
          .where(and(eq(products.tenantId, ctx.tenantId), inArray(products.slug, handles)))
      : [];
    const productBySlug = new Map(existingProducts.map((p) => [p.slug, p]));
    const skus = [...new Set(input.map((r) => (r.raw.sku ?? '').toLowerCase()).filter(Boolean))];
    const existingVariants = skus.length
      ? await tx
          .select({ v: variants, slug: products.slug })
          .from(variants)
          .innerJoin(products, eq(products.id, variants.productId))
          .where(and(eq(variants.tenantId, ctx.tenantId), inArray(sql`lower(${variants.sku})`, skus)))
      : [];
    const variantBySku = new Map(existingVariants.map((e) => [e.v.sku.toLowerCase(), e]));
    // All variant SKUs of the matched products (not only those in the file).
    const allVariantsOfExisting = existingProducts.length
      ? await tx
          .select({ productId: variants.productId, sku: variants.sku })
          .from(variants)
          .where(
            inArray(
              variants.productId,
              existingProducts.map((p) => p.id),
            ),
          )
      : [];
    const categoryRows = await tx.select().from(categories).where(eq(categories.tenantId, ctx.tenantId));
    const categoryBySlug = new Map(categoryRows.map((c) => [c.slug, c.id]));

    const seenSku = new Map<string, number>();
    const byHandle = new Map<string, { line: number; raw: Raw }[]>();
    for (const row of input) {
      const { line, raw } = row;
      if (!Slug.safeParse(raw.handle).success)
        err(line, 'handle', 'Handle must be a lower-case slug like gold-ring-18k');
      if (!Sku.safeParse(raw.sku).success) err(line, 'sku', 'Invalid or missing SKU');
      if (raw.barcode && !Barcode.safeParse(raw.barcode).success)
        err(line, 'barcode', 'Barcode must be 4-48 letters, digits or hyphens');
      if (raw.status && !ProductStatus.safeParse(raw.status).success)
        err(line, 'status', 'Status must be draft, active or archived');
      if (raw.product_type && !ProductType.safeParse(raw.product_type).success)
        err(line, 'product_type', 'Product type must be standard or jewellery');
      if (raw.product_type === 'jewellery' && !ctx.features.includes('jewellery'))
        err(line, 'product_type', 'Jewellery products are not enabled for this merchant');
      if (raw.category_slug && !categoryBySlug.has(raw.category_slug))
        err(line, 'category_slug', `Unknown category "${raw.category_slug}"`);
      if ((raw.title ?? '').length > 200) err(line, 'title', 'Title is longer than 200 characters');
      for (const n of [1, 2]) {
        const name = raw[`option${n}_name`] ?? '';
        const value = raw[`option${n}_value`] ?? '';
        if (Boolean(name) !== Boolean(value))
          err(line, `option${n}_value`, `option${n}_name and option${n}_value must be given together`);
      }
      const sku = (raw.sku ?? '').toLowerCase();
      if (sku) {
        const first = seenSku.get(sku);
        if (first !== undefined) err(line, 'sku', `SKU already used on line ${first} of this file`);
        else seenSku.set(sku, line);
        const owner = variantBySku.get(sku);
        if (owner && owner.slug !== raw.handle)
          err(line, 'sku', `SKU belongs to existing product "${owner.slug}"`);
      }
      if (raw.handle) byHandle.set(raw.handle, [...(byHandle.get(raw.handle) ?? []), row]);
    }

    const groups: Group[] = [];
    for (const [handle, rows] of byHandle) {
      const existing = productBySlug.get(handle) ?? null;
      const first = rows[0]!.raw;
      const lines = rows.map((r) => r.line);
      const groupErr = (message: string, field = 'handle') =>
        rows.forEach((r) => err(r.line, field, message));
      // Product-level values come from the first row; later rows may repeat or leave them blank.
      for (const r of rows.slice(1)) {
        for (const f of [
          'title',
          'status',
          'product_type',
          'brand',
          'category_slug',
          'tags',
          'description',
        ]) {
          if (r.raw[f] && first[f] && r.raw[f] !== first[f])
            err(r.line, f, `Differs from line ${rows[0]!.line} for the same handle`);
        }
      }
      if (!existing && !first.title) err(rows[0]!.line, 'title', 'Title is required for a new product');
      if (existing && first.product_type && first.product_type !== existing.productType) {
        err(rows[0]!.line, 'product_type', 'Product type of an existing product cannot change');
      }
      if (existing && first.status && ProductStatus.safeParse(first.status).success) {
        try {
          assertTransition(existing.status, first.status as ProductStatus);
        } catch (e) {
          err(rows[0]!.line, 'status', (e as Error).message);
        }
      }
      // Option axes must be the same for all rows (and match an existing product's axes).
      const names = (raw: Raw) => [raw.option1_name, raw.option2_name].filter((n): n is string => Boolean(n));
      const axis = names(first);
      if (rows.some((r) => names(r.raw).join('|').toLowerCase() !== axis.join('|').toLowerCase())) {
        groupErr('All rows of a product must use the same option names', 'option1_name');
      }
      const existingOptions = (existing?.options as ProductOption[] | undefined) ?? [];
      if (existing && existing.options && (existingOptions.length || axis.length)) {
        const existingNames = existingOptions.map((o) => o.name.toLowerCase()).join('|');
        if (existingNames !== axis.map((a) => a.toLowerCase()).join('|')) {
          groupErr(
            `Existing product options are: ${existingOptions.map((o) => o.name).join(', ') || 'none'}`,
            'option1_name',
          );
        }
      }
      const fileSkus = new Set(rows.map((r) => (r.raw.sku ?? '').toLowerCase()));
      const unmentioned = existing
        ? allVariantsOfExisting.some((v) => v.productId === existing.id && !fileSkus.has(v.sku.toLowerCase()))
        : false;
      if (axis.length === 0 && (rows.length > 1 || unmentioned)) {
        groupErr('Products with several variants need option columns', 'option1_name');
      }
      const planned: PlannedVariant[] = rows.map(({ raw }) => {
        const optionValues: Record<string, string> = {};
        axis.forEach((name, i) => (optionValues[name] = raw[`option${i + 1}_value`] ?? ''));
        const sku = raw.sku ?? '';
        return {
          sku,
          barcode: raw.barcode || null,
          title: raw.variant_title || Object.values(optionValues).join(' / '),
          optionValues,
          key: optionKey(optionValues),
          existingId: variantBySku.get(sku.toLowerCase())?.v.id ?? null,
        };
      });
      const keys = new Map<string, number>();
      planned.forEach((p, i) => {
        const prev = keys.get(p.key);
        if (prev !== undefined) err(lines[i]!, 'option1_value', `Same option values as line ${prev}`);
        else keys.set(p.key, lines[i]!);
      });
      // Option values: union of existing and new (only additions — existing variants stay valid).
      const options: ProductOption[] = axis.map((name, i) => {
        const prior = existingOptions.find((o) => o.name.toLowerCase() === name.toLowerCase());
        const values = [...(prior?.values ?? [])];
        for (const r of rows) {
          const v = r.raw[`option${i + 1}_value`];
          if (v && !values.some((x) => x.toLowerCase() === v.toLowerCase())) values.push(v);
        }
        return { name: prior?.name ?? name, values };
      });
      if (lines.some((l) => rowErrors.has(l))) {
        // One bad row skips the whole product so a product is never imported half-way.
        for (const l of lines)
          if (!rowErrors.has(l)) err(l, 'handle', 'Skipped: another row of this product has errors');
        continue;
      }
      groups.push({
        handle,
        lines,
        existing,
        fields: {
          title: first.title || null,
          status: (first.status as ProductStatus) || null,
          productType: (first.product_type as ProductType) || null,
          brand: first.brand || null,
          categoryId: first.category_slug ? categoryBySlug.get(first.category_slug)! : null,
          tags: first.tags
            ? first.tags
                .split(';')
                .map((t) => t.trim())
                .filter(Boolean)
            : null,
          description: first.description || null,
        },
        options,
        variants: planned,
      });
    }

    const rows: ImportRow[] = input.map(({ line, raw }) => {
      const errors = rowErrors.get(line) ?? [];
      const exists = Boolean(raw.handle && productBySlug.has(raw.handle));
      const variantExists = Boolean(raw.sku && variantBySku.has(raw.sku.toLowerCase()));
      return {
        line,
        handle: raw.handle ?? '',
        sku: raw.sku ?? '',
        action: errors.length ? 'error' : exists ? 'update_product' : 'create_product',
        variantAction: errors.length ? 'none' : variantExists ? 'update' : 'create',
        errors,
        raw,
      };
    });
    return { rows, groups };
  }

  async preview(
    auth: AuthState,
    ctx: TenantState,
    input: CreateImportRequest,
    meta: RequestMeta,
  ): Promise<ImportBatch> {
    const parsed = this.parse(input.content);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const plan = await this.analyze(tx, ctx, parsed);
      const errorCount = plan.rows.filter((r) => r.errors.length).length;
      const [batch] = await tx
        .insert(catalogImportBatches)
        .values({
          tenantId: ctx.tenantId,
          filename: input.filename,
          rowCount: plan.rows.length,
          validCount: plan.rows.length - errorCount,
          errorCount,
          rows: plan.rows,
          createdBy: auth.userId,
        })
        .returning();
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: 'catalog.import_previewed',
        entityType: 'catalog_import',
        entityId: batch!.id,
        newValues: { filename: input.filename, rows: plan.rows.length, errors: errorCount },
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return this.toBatch(batch!);
    });
  }

  private async lockBatch(tx: Tx, ctx: TenantState, id: string): Promise<BatchRow> {
    const [b] = await tx
      .select()
      .from(catalogImportBatches)
      .where(and(eq(catalogImportBatches.tenantId, ctx.tenantId), eq(catalogImportBatches.id, id)))
      .for('update');
    if (!b) throw Errors.notFound('Import');
    if (b.status !== 'previewed') {
      throw new AppError(409, 'INVALID_STATE_TRANSITION', `This import is already ${b.status}`, {
        status: b.status,
      });
    }
    return b;
  }

  async commit(auth: AuthState, ctx: TenantState, id: string, meta: RequestMeta): Promise<ImportBatch> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const batch = await this.lockBatch(tx, ctx, id);
      const stored = batch.rows as ImportRow[];
      const plan = await this.analyze(
        tx,
        ctx,
        stored.map((r) => ({ line: r.line, raw: r.raw })),
      );
      const failing = (rows: ImportRow[]) =>
        rows
          .filter((r) => r.errors.length)
          .map((r) => r.line)
          .join(',');
      const nowErrors = plan.rows.filter((r) => r.errors.length).length;
      if (failing(plan.rows) !== failing(stored)) {
        throw new AppError(
          409,
          'CONFLICT',
          'Catalog data changed since this preview. Upload the file again to re-check.',
          {
            previewErrors: batch.errorCount,
            currentErrors: nowErrors,
          },
        );
      }
      // Phase 12: new products count against the plan (the whole commit is refused, nothing half-imported).
      await assertPlanCapacity(
        tx,
        ctx.tenantId,
        'products',
        plan.groups.filter((g) => !g.existing && g.fields.status !== 'archived').length,
      );
      const summary = { productsCreated: 0, productsUpdated: 0, variantsCreated: 0, variantsUpdated: 0 };
      for (const g of plan.groups) {
        let productId: string;
        if (g.existing) {
          const p = g.existing;
          await tx
            .update(products)
            .set({
              title: g.fields.title ?? p.title,
              status: g.fields.status ?? p.status,
              brand: g.fields.brand ?? p.brand,
              categoryId: g.fields.categoryId ?? p.categoryId,
              tags: g.fields.tags ?? p.tags,
              description: g.fields.description ?? p.description,
              options: g.options,
              version: p.version + 1,
              updatedAt: new Date(),
            })
            .where(eq(products.id, p.id));
          productId = p.id;
          summary.productsUpdated++;
        } else {
          const [p] = await tx
            .insert(products)
            .values({
              tenantId: ctx.tenantId,
              title: g.fields.title!,
              slug: g.handle,
              status: 'draft', // set after variants exist (activation needs an active variant)
              productType: g.fields.productType ?? 'standard',
              brand: g.fields.brand,
              categoryId: g.fields.categoryId,
              tags: g.fields.tags ?? [],
              description: g.fields.description ?? '',
              options: g.options,
              createdBy: auth.userId,
            })
            .returning({ id: products.id });
          productId = p!.id;
          summary.productsCreated++;
        }
        const [{ maxPos } = { maxPos: -1 }] = await tx
          .select({ maxPos: sql<number>`coalesce(max(${variants.position}), -1)::int` })
          .from(variants)
          .where(eq(variants.productId, productId));
        let position = maxPos + 1;
        for (const v of g.variants) {
          if (v.existingId) {
            await tx
              .update(variants)
              .set({
                sku: v.sku,
                barcode: v.barcode,
                title: v.title,
                optionValues: v.optionValues,
                optionKey: v.key,
                version: sql`${variants.version} + 1`,
                updatedAt: new Date(),
              })
              .where(eq(variants.id, v.existingId));
            summary.variantsUpdated++;
          } else {
            await tx.insert(variants).values({
              tenantId: ctx.tenantId,
              productId,
              sku: v.sku,
              barcode: v.barcode,
              title: v.title,
              optionValues: v.optionValues,
              optionKey: v.key,
              position: position++,
            });
            summary.variantsCreated++;
          }
        }
        if (!g.existing && g.fields.status && g.fields.status !== 'draft') {
          await tx.update(products).set({ status: g.fields.status }).where(eq(products.id, productId));
        }
      }
      const [after] = await tx
        .update(catalogImportBatches)
        .set({
          status: 'committed',
          summary,
          committedBy: auth.userId,
          committedAt: new Date(),
          version: batch.version + 1,
        })
        .where(eq(catalogImportBatches.id, id))
        .returning();
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: 'catalog.import_committed',
        entityType: 'catalog_import',
        entityId: id,
        newValues: { ...summary, handles: plan.groups.map((g) => g.handle) },
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return this.toBatch(after!);
    });
  }

  async discard(auth: AuthState, ctx: TenantState, id: string, meta: RequestMeta): Promise<ImportBatch> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const batch = await this.lockBatch(tx, ctx, id);
      const [after] = await tx
        .update(catalogImportBatches)
        .set({ status: 'discarded', version: batch.version + 1 })
        .where(eq(catalogImportBatches.id, id))
        .returning();
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: 'catalog.import_discarded',
        entityType: 'catalog_import',
        entityId: id,
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return this.toBatch(after!);
    });
  }

  async get(ctx: TenantState, id: string): Promise<ImportBatch> {
    const [b] = await this.db.tenant(ctx.tenantId, (tx) =>
      tx
        .select()
        .from(catalogImportBatches)
        .where(and(eq(catalogImportBatches.tenantId, ctx.tenantId), eq(catalogImportBatches.id, id))),
    );
    if (!b) throw Errors.notFound('Import');
    return this.toBatch(b);
  }

  async list(
    ctx: TenantState,
    query: { limit?: number; cursor?: string },
  ): Promise<Page<Omit<ImportBatch, 'rows'>>> {
    const limit = query.limit ?? 25;
    const cursor = decodeCursor(query.cursor);
    const rows = await this.db.tenant(ctx.tenantId, (tx) =>
      tx
        .select()
        .from(catalogImportBatches)
        .where(
          and(
            eq(catalogImportBatches.tenantId, ctx.tenantId),
            cursor
              ? or(
                  lt(catalogImportBatches.createdAt, new Date(String(cursor.sortValue))),
                  and(
                    eq(catalogImportBatches.createdAt, new Date(String(cursor.sortValue))),
                    lt(catalogImportBatches.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(catalogImportBatches.createdAt), desc(catalogImportBatches.id))
        .limit(limit + 1),
    );
    const page = paginate(rows, limit, (r) => r.createdAt.toISOString());
    return {
      items: page.items.map((b) => {
        const { rows: _rows, ...rest } = this.toBatch(b);
        return rest;
      }),
      nextCursor: page.nextCursor,
    };
  }
}
