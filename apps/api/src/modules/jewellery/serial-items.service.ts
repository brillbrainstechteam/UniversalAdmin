import { Injectable } from '@nestjs/common';
import {
  compareGrams,
  type BulkSerialItemsRequest,
  type BulkSerialItemsResponse,
  type CreateSerialItemRequest,
  type ReviewSerialItemRequest,
  type SerialItem,
  type SerialItemInput,
  type SerialItemListQuery,
  type UpdateSerialItemRequest,
} from '@uc/contracts';
import {
  jewelleryComponents,
  jewellerySpecs,
  products,
  serialItems,
  users,
  variants,
  writeAudit,
  type Tx,
} from '@uc/db';
import { and, asc, desc, eq, gt, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { decodeCursor, paginate } from '../../common/cursor';
import { AppError, Errors } from '../../common/errors';
import { iso, likePattern } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';
import { componentValues, loadPurities, loadSettings, purityRef, toComponent } from './jewellery.service';
import {
  Issues,
  measurementChecks,
  normalizeComponents,
  normalizeHuid,
  notJewellery,
  resolveFine,
  type NormalizedComponent,
  type PurityInfo,
  type Settings,
} from './measurements';

type ItemRow = typeof serialItems.$inferSelect;

interface Prepared {
  serialTag: string;
  huid: string | null;
  purity: PurityInfo;
  grossG: string;
  netG: string;
  stoneG: string;
  fineG: string;
  fineSource: 'computed' | 'entered';
  fineFormula: Record<string, unknown> | null;
  pieces: number;
  status: 'pending_review' | 'active';
  weightExceptionReason: string | null;
  certificates: unknown[];
  components: NormalizedComponent[];
  raw: Record<string, unknown>;
}

const MEASUREMENT_FIELDS = ['gross', 'net', 'stone', 'fine', 'pieces', 'purityId', 'components'] as const;

@Injectable()
export class SerialItemsService {
  constructor(private readonly db: DbService) {}

  private requireFeature(ctx: TenantState) {
    if (!ctx.features.includes('serialized_items')) throw Errors.featureNotEntitled('serialized_items');
  }

  /** Variant must be a jewellery product variant with a spec (purity default + metal). */
  private async variantContext(tx: Tx, ctx: TenantState, variantId: string) {
    const [row] = await tx
      .select({
        v: variants,
        productType: products.productType,
        productTitle: products.title,
        spec: jewellerySpecs,
      })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .leftJoin(jewellerySpecs, eq(jewellerySpecs.variantId, variants.id))
      .where(and(eq(variants.tenantId, ctx.tenantId), eq(variants.id, variantId)));
    if (!row) throw Errors.notFound('Variant');
    if (row.productType !== 'jewellery') throw notJewellery();
    return row;
  }

  /** Converts and validates one input row; pushes issues with `path` prefix. */
  private prepare(
    issues: Issues,
    path: string,
    input: SerialItemInput,
    defaults: { purityId: string | null; pieces: number },
    purities: Map<string, PurityInfo>,
    settings: Settings,
    source: string,
  ): Prepared | null {
    const before = issues.list.length;
    const purityId = input.purityId ?? defaults.purityId;
    const purity = purityId ? purities.get(purityId) : undefined;
    if (!purityId)
      issues.add(`${path}.purityId`, 'Set a purity (or add a jewellery spec to the variant first)');
    else if (!purity || purity.status !== 'active')
      issues.add(`${path}.purityId`, 'Unknown or inactive purity');
    for (const f of ['gross', 'net', 'fine'] as const) {
      if (input[f]?.unit === 'ct') issues.add(`${path}.${f}.unit`, 'Carats are only valid for stone weights');
    }
    const grossG = issues.grams(`${path}.gross`, input.gross);
    const netG = issues.grams(`${path}.net`, input.net);
    const stoneG = issues.grams(`${path}.stone`, input.stone) ?? '0.000000';
    const huid = normalizeHuid(issues, `${path}.huid`, input.huid, settings) ?? null;
    const components = normalizeComponents(issues, `${path}.components`, input.components, purities);
    const exception = grossG !== null && netG !== null && compareGrams(netG, grossG) > 0;
    if (exception && !input.weightExceptionReason) {
      issues.add(
        `${path}.net`,
        'Net weight exceeds gross weight. Correct it, or give a weight exception reason for review.',
      );
    }
    if (issues.list.length > before || !purity || !grossG || !netG) return null;
    const fine = resolveFine(
      issues,
      `${path}.fine`,
      input.fine,
      netG,
      purity,
      components,
      purities,
      settings,
    );
    if (issues.list.length > before) return null;
    return {
      serialTag: input.serialTag,
      huid,
      purity,
      grossG,
      netG,
      stoneG,
      fineG: fine.fineG!,
      fineSource: fine.source!,
      fineFormula: fine.formula,
      pieces: input.pieces ?? defaults.pieces,
      status: exception ? 'pending_review' : 'active',
      weightExceptionReason: exception ? input.weightExceptionReason! : null,
      certificates: input.certificates,
      components,
      raw: {
        gross: input.gross,
        net: input.net,
        stone: input.stone ?? null,
        fine: input.fine ?? null,
        huid: input.huid ?? null,
        source,
      },
    };
  }

  /** Detects tag/HUID collisions inside the batch and against existing items. */
  private async assertUnique(
    tx: Tx,
    ctx: TenantState,
    issues: Issues,
    rows: { path: string; tag: string; huid: string | null; selfId?: string }[],
  ) {
    const tags = new Map<string, string>();
    const huids = new Map<string, string>();
    for (const r of rows) {
      const t = r.tag.toLowerCase();
      if (tags.has(t)) issues.add(`${r.path}.serialTag`, `Duplicate tag (also at ${tags.get(t)})`);
      else tags.set(t, r.path);
      if (r.huid) {
        if (huids.has(r.huid)) issues.add(`${r.path}.huid`, `Duplicate HUID (also at ${huids.get(r.huid)})`);
        else huids.set(r.huid, r.path);
      }
    }
    const existing = await tx
      .select({ id: serialItems.id, tag: serialItems.serialTag, huid: serialItems.huid })
      .from(serialItems)
      .where(
        and(
          eq(serialItems.tenantId, ctx.tenantId),
          or(
            // '' keeps each IN list non-empty and never matches (tags and HUIDs are never empty).
            inArray(sql`lower(${serialItems.serialTag})`, [...tags.keys(), '']),
            inArray(serialItems.huid, [...huids.keys(), '']),
          ),
        ),
      );
    for (const e of existing) {
      for (const r of rows) {
        if (r.selfId === e.id) continue;
        if (e.tag.toLowerCase() === r.tag.toLowerCase())
          issues.add(`${r.path}.serialTag`, `Tag ${e.tag} is already used by another item`);
        if (r.huid && e.huid === r.huid)
          issues.add(`${r.path}.huid`, `HUID ${r.huid} is already assigned to another item`);
      }
    }
  }

  private async insertPrepared(
    tx: Tx,
    ctx: TenantState,
    auth: AuthState,
    variantId: string,
    p: Prepared,
  ): Promise<string> {
    const [row] = await tx
      .insert(serialItems)
      .values({
        tenantId: ctx.tenantId,
        variantId,
        serialTag: p.serialTag,
        huid: p.huid,
        metal: p.purity.metal as ItemRow['metal'],
        purityId: p.purity.id,
        grossG: p.grossG,
        netG: p.netG,
        stoneG: p.stoneG,
        fineG: p.fineG,
        fineSource: p.fineSource,
        fineFormula: p.fineFormula,
        pieces: p.pieces,
        status: p.status,
        weightExceptionReason: p.weightExceptionReason,
        certificates: p.certificates,
        raw: p.raw,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: serialItems.id });
    if (p.components.length)
      await tx
        .insert(jewelleryComponents)
        .values(componentValues(ctx.tenantId, { itemId: row!.id }, p.components));
    return row!.id;
  }

  private async load(tx: Tx, ctx: TenantState, id: string): Promise<SerialItem> {
    const [row] = await tx
      .select({
        i: serialItems,
        sku: variants.sku,
        productId: products.id,
        productTitle: products.title,
        reviewer: users.email,
      })
      .from(serialItems)
      .innerJoin(variants, eq(variants.id, serialItems.variantId))
      .innerJoin(products, eq(products.id, variants.productId))
      .leftJoin(users, eq(users.id, serialItems.reviewedBy))
      .where(and(eq(serialItems.tenantId, ctx.tenantId), eq(serialItems.id, id)));
    if (!row) throw Errors.notFound('Serialized item');
    const comps = await tx
      .select()
      .from(jewelleryComponents)
      .where(eq(jewelleryComponents.itemId, id))
      .orderBy(asc(jewelleryComponents.position));
    const purities = await loadPurities(tx, ctx.tenantId);
    const settings = await loadSettings(tx, ctx.tenantId);
    const i = row.i;
    const purity = purities.get(i.purityId)!;
    return {
      id: i.id,
      variantId: i.variantId,
      productId: row.productId,
      productTitle: row.productTitle,
      sku: row.sku,
      serialTag: i.serialTag,
      huid: i.huid,
      metal: i.metal,
      purity: purityRef(purity),
      grossG: i.grossG,
      netG: i.netG,
      stoneG: i.stoneG,
      fineG: i.fineG,
      fineSource: i.fineSource,
      fineFormula: (i.fineFormula as Record<string, unknown> | null) ?? null,
      pieces: i.pieces,
      status: i.status,
      weightExceptionReason: i.weightExceptionReason,
      review: i.reviewedAt ? { by: row.reviewer, at: iso(i.reviewedAt), note: i.reviewNote } : null,
      certificates: i.certificates as SerialItem['certificates'],
      components: comps.map((c) => toComponent(c, purities)),
      raw: i.raw as Record<string, unknown>,
      checks: measurementChecks(i, purity, comps, purities, settings),
      version: i.version,
      createdAt: iso(i.createdAt),
      updatedAt: iso(i.updatedAt),
    };
  }

  private audit(
    tx: Tx,
    auth: AuthState,
    ctx: TenantState,
    meta: RequestMeta,
    action: string,
    entityId: string,
    values: {
      oldValues?: Record<string, unknown> | null;
      newValues?: Record<string, unknown> | null;
      reason?: string | null;
    },
  ) {
    return writeAudit(tx, {
      tenantId: ctx.tenantId,
      actorType: 'user',
      actorUserId: auth.userId,
      action,
      entityType: 'serial_item',
      entityId,
      oldValues: values.oldValues ?? null,
      newValues: values.newValues ?? null,
      reason: values.reason ?? null,
      correlationId: meta.correlationId,
      ip: meta.ip,
    });
  }

  // ---------------------------------------------------------------- queries

  get(ctx: TenantState, id: string): Promise<SerialItem> {
    this.requireFeature(ctx);
    return this.db.tenant(ctx.tenantId, (tx) => this.load(tx, ctx, id));
  }

  async list(ctx: TenantState, query: SerialItemListQuery) {
    this.requireFeature(ctx);
    const descending = query.sort.startsWith('-');
    const field = query.sort.replace('-', '') as 'createdAt' | 'serialTag' | 'grossG';
    const column =
      field === 'serialTag'
        ? serialItems.serialTag
        : field === 'grossG'
          ? serialItems.grossG
          : serialItems.createdAt;
    const cursor = decodeCursor(query.cursor);
    const where: (SQL | undefined)[] = [eq(serialItems.tenantId, ctx.tenantId)];
    if (query.status) where.push(eq(serialItems.status, query.status));
    if (query.variantId) where.push(eq(serialItems.variantId, query.variantId));
    if (query.productId) where.push(eq(variants.productId, query.productId));
    if (query.metal) where.push(eq(serialItems.metal, query.metal));
    if (query.purityId) where.push(eq(serialItems.purityId, query.purityId));
    if (query.q) {
      const p = likePattern(query.q);
      where.push(
        or(
          ilike(serialItems.serialTag, p),
          ilike(serialItems.huid, p),
          ilike(variants.sku, p),
          ilike(products.title, p),
        ),
      );
    }
    if (cursor) {
      const v = field === 'createdAt' ? new Date(String(cursor.sortValue)) : String(cursor.sortValue);
      const cmp = descending ? lt : gt;
      // NUMERIC compares exactly in SQL; the cursor carries the decimal string.
      where.push(or(cmp(column, v), and(eq(column, v), cmp(serialItems.id, cursor.id))));
    }
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const rows = await tx
        .select({ i: serialItems, sku: variants.sku, productId: products.id, productTitle: products.title })
        .from(serialItems)
        .innerJoin(variants, eq(variants.id, serialItems.variantId))
        .innerJoin(products, eq(products.id, variants.productId))
        .where(and(...where))
        .orderBy(...(descending ? [desc(column), desc(serialItems.id)] : [asc(column), asc(serialItems.id)]))
        .limit(query.limit + 1);
      const purities = await loadPurities(tx, ctx.tenantId);
      const settings = await loadSettings(tx, ctx.tenantId);
      const page = paginate(
        rows.map((r) => ({ id: r.i.id, r })),
        query.limit,
        ({ r }) =>
          field === 'createdAt'
            ? r.i.createdAt.toISOString()
            : field === 'grossG'
              ? r.i.grossG
              : r.i.serialTag,
      );
      return {
        items: page.items.map(({ r }) => {
          const purity = purities.get(r.i.purityId)!;
          return {
            id: r.i.id,
            variantId: r.i.variantId,
            productId: r.productId,
            productTitle: r.productTitle,
            sku: r.sku,
            serialTag: r.i.serialTag,
            huid: r.i.huid,
            metal: r.i.metal,
            purity: purityRef(purity),
            grossG: r.i.grossG,
            netG: r.i.netG,
            stoneG: r.i.stoneG,
            fineG: r.i.fineG,
            fineSource: r.i.fineSource,
            pieces: r.i.pieces,
            status: r.i.status,
            weightExceptionReason: r.i.weightExceptionReason,
            review: null,
            certificates: r.i.certificates as SerialItem['certificates'],
            checks: measurementChecks(r.i, purity, [], purities, settings),
            version: r.i.version,
            createdAt: iso(r.i.createdAt),
            updatedAt: iso(r.i.updatedAt),
          };
        }),
        nextCursor: page.nextCursor,
      };
    });
  }

  // ---------------------------------------------------------------- create

  async create(
    auth: AuthState,
    ctx: TenantState,
    input: CreateSerialItemRequest,
    meta: RequestMeta,
  ): Promise<SerialItem> {
    this.requireFeature(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const v = await this.variantContext(tx, ctx, input.variantId);
      const purities = await loadPurities(tx, ctx.tenantId);
      const settings = await loadSettings(tx, ctx.tenantId);
      const issues = new Issues();
      const { variantId, ...rest } = input;
      const prepared = this.prepare(
        issues,
        'item',
        rest,
        { purityId: v.spec?.purityId ?? null, pieces: v.spec?.piecesPerUnit ?? 1 },
        purities,
        settings,
        'manual',
      );
      if (prepared)
        await this.assertUnique(tx, ctx, issues, [
          { path: 'item', tag: prepared.serialTag, huid: prepared.huid },
        ]);
      // Single-item API reports paths without the "item." prefix.
      if (issues.list.length)
        throw Errors.validation(issues.list.map((i) => ({ ...i, path: i.path.replace(/^item\./, '') })));
      const id = await this.insertPrepared(tx, ctx, auth, variantId, prepared!);
      await this.audit(tx, auth, ctx, meta, 'serial_item.created', id, {
        newValues: {
          serialTag: prepared!.serialTag,
          huid: prepared!.huid,
          grossG: prepared!.grossG,
          netG: prepared!.netG,
          stoneG: prepared!.stoneG,
          fineG: prepared!.fineG,
          status: prepared!.status,
        },
        reason: prepared!.weightExceptionReason,
      });
      return this.load(tx, ctx, id);
    });
  }

  async bulk(
    auth: AuthState,
    ctx: TenantState,
    input: BulkSerialItemsRequest,
    meta: RequestMeta,
  ): Promise<BulkSerialItemsResponse> {
    this.requireFeature(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const v = await this.variantContext(tx, ctx, input.variantId);
      const purities = await loadPurities(tx, ctx.tenantId);
      const settings = await loadSettings(tx, ctx.tenantId);
      const issues = new Issues();
      const defaults = { purityId: v.spec?.purityId ?? null, pieces: v.spec?.piecesPerUnit ?? 1 };
      const prepared = input.items.map((item, i) =>
        this.prepare(issues, `items.${i}`, item, defaults, purities, settings, 'bulk'),
      );
      await this.assertUnique(
        tx,
        ctx,
        issues,
        input.items.map((item, i) => ({
          path: `items.${i}`,
          tag: item.serialTag,
          huid: prepared[i]?.huid ?? (item.huid ? item.huid.trim().toUpperCase() : null),
        })),
      );
      // Malformed rows quarantine the whole batch: nothing is written and every problem is reported.
      issues.throwIfAny();
      const rows: BulkSerialItemsResponse['rows'] = [];
      for (const [index, p] of prepared.entries()) {
        const id = input.dryRun ? null : await this.insertPrepared(tx, ctx, auth, input.variantId, p!);
        rows.push({
          index,
          serialTag: p!.serialTag,
          grossG: p!.grossG,
          netG: p!.netG,
          stoneG: p!.stoneG,
          fineG: p!.fineG,
          status: p!.status,
          checks: measurementChecks(
            { ...p!, fineSource: p!.fineSource },
            p!.purity,
            p!.components.map((c) => ({ kind: c.kind, weightG: c.weightG, purityId: c.purityId })),
            purities,
            settings,
          ),
          id,
        });
      }
      if (!input.dryRun) {
        await this.audit(tx, auth, ctx, meta, 'serial_item.bulk_created', input.variantId, {
          newValues: { variantId: input.variantId, count: rows.length, tags: rows.map((r) => r.serialTag) },
        });
      }
      return { dryRun: input.dryRun, created: input.dryRun ? 0 : rows.length, rows };
    });
  }

  // ---------------------------------------------------------------- update (edit policy)

  async update(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: UpdateSerialItemRequest,
    meta: RequestMeta,
  ): Promise<SerialItem> {
    this.requireFeature(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [before] = await tx
        .select()
        .from(serialItems)
        .where(and(eq(serialItems.tenantId, ctx.tenantId), eq(serialItems.id, id)))
        .for('update');
      if (!before) throw Errors.notFound('Serialized item');
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      if (before.status === 'retired') {
        throw new AppError(409, 'INVALID_STATE_TRANSITION', 'Retired items are read-only');
      }
      const purities = await loadPurities(tx, ctx.tenantId);
      const settings = await loadSettings(tx, ctx.tenantId);
      const issues = new Issues();
      const measurementsChanged = MEASUREMENT_FIELDS.some((f) => input[f] !== undefined);
      const huid = normalizeHuid(issues, 'huid', input.huid, settings);
      const huidChanged = huid !== undefined && huid !== before.huid;
      // Edit policy (J-05).
      if (before.status === 'active' && (measurementsChanged || huidChanged) && !input.reason) {
        issues.add('reason', 'Give a reason when correcting measurements or the HUID of an active item');
      }
      if (huidChanged && before.huid !== null && !ctx.permissions.has('jewellery.review')) {
        throw Errors.permission('jewellery.review');
      }
      issues.throwIfAny();

      const existingComponents = await tx
        .select()
        .from(jewelleryComponents)
        .where(eq(jewelleryComponents.itemId, id))
        .orderBy(asc(jewelleryComponents.position));
      const raw = before.raw as Record<string, unknown>;
      // Re-run the full measurement pipeline on the merged input so every rule applies to the new state.
      const merged: SerialItemInput = {
        serialTag: input.serialTag ?? before.serialTag,
        huid: huid === undefined ? before.huid : huid,
        purityId: input.purityId ?? before.purityId,
        gross: input.gross ?? (raw.gross as SerialItemInput['gross']) ?? { value: before.grossG, unit: 'g' },
        net: input.net ?? (raw.net as SerialItemInput['net']) ?? { value: before.netG, unit: 'g' },
        stone: input.stone ?? (raw.stone as SerialItemInput['stone']) ?? { value: before.stoneG, unit: 'g' },
        fine:
          input.fine === undefined
            ? before.fineSource === 'entered'
              ? ((raw.fine as SerialItemInput['fine']) ?? { value: before.fineG, unit: 'g' })
              : null
            : input.fine,
        pieces: input.pieces ?? before.pieces,
        certificates: input.certificates ?? (before.certificates as SerialItemInput['certificates']),
        components:
          input.components ??
          existingComponents.map((c) => ({
            kind: c.kind,
            description: c.description,
            shape: c.shape,
            grade: c.grade,
            count: c.count,
            weight: (c.raw as { weight?: SerialItemInput['gross'] }).weight ?? {
              value: c.weightG,
              unit: 'g',
            },
            purityId: c.purityId,
            certificate: c.certificate,
          })),
        weightExceptionReason:
          input.weightExceptionReason === undefined
            ? before.weightExceptionReason
            : input.weightExceptionReason,
      };
      const p = this.prepare(
        issues,
        'item',
        merged,
        { purityId: before.purityId, pieces: before.pieces },
        purities,
        settings,
        'manual_edit',
      );
      if (p)
        await this.assertUnique(tx, ctx, issues, [
          { path: 'item', tag: p.serialTag, huid: p.huid, selfId: id },
        ]);
      if (issues.list.length)
        throw Errors.validation(issues.list.map((i) => ({ ...i, path: i.path.replace(/^item\./, '') })));

      // pending_review stays pending while the exception exists; resolving it re-activates automatically.
      const status = input.status === 'retired' ? 'retired' : p!.status;
      const exceptionChanged = p!.weightExceptionReason !== before.weightExceptionReason;
      const [after] = await tx
        .update(serialItems)
        .set({
          serialTag: p!.serialTag,
          huid: p!.huid,
          metal: p!.purity.metal as ItemRow['metal'],
          purityId: p!.purity.id,
          grossG: p!.grossG,
          netG: p!.netG,
          stoneG: p!.stoneG,
          fineG: p!.fineG,
          fineSource: p!.fineSource,
          fineFormula: p!.fineFormula,
          pieces: p!.pieces,
          status,
          weightExceptionReason: p!.weightExceptionReason,
          ...(exceptionChanged || status === 'pending_review'
            ? { reviewedBy: null, reviewedAt: null, reviewNote: null }
            : {}),
          certificates: p!.certificates,
          raw: measurementsChanged
            ? {
                ...p!.raw,
                previous: {
                  grossG: before.grossG,
                  netG: before.netG,
                  stoneG: before.stoneG,
                  fineG: before.fineG,
                },
              }
            : before.raw,
          updatedBy: auth.userId,
          version: before.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(serialItems.id, id), eq(serialItems.version, input.version)))
        .returning();
      if (!after) throw Errors.versionConflict();
      if (input.components) {
        await tx.delete(jewelleryComponents).where(eq(jewelleryComponents.itemId, id));
        if (p!.components.length)
          await tx
            .insert(jewelleryComponents)
            .values(componentValues(ctx.tenantId, { itemId: id }, p!.components));
      }
      const snap = (r: ItemRow) => ({
        serialTag: r.serialTag,
        huid: r.huid,
        purityId: r.purityId,
        grossG: r.grossG,
        netG: r.netG,
        stoneG: r.stoneG,
        fineG: r.fineG,
        fineSource: r.fineSource,
        pieces: r.pieces,
        status: r.status,
      });
      const action =
        input.status === 'retired'
          ? 'serial_item.retired'
          : huidChanged && before.huid !== null
            ? 'serial_item.huid_corrected'
            : measurementsChanged && before.status === 'active'
              ? 'serial_item.measurements_corrected'
              : 'serial_item.updated';
      const old = snap(before);
      const next = snap(after);
      const changedKeys = Object.keys(next).filter(
        (k) => JSON.stringify(next[k as keyof typeof next]) !== JSON.stringify(old[k as keyof typeof old]),
      );
      await this.audit(tx, auth, ctx, meta, action, id, {
        oldValues: Object.fromEntries(changedKeys.map((k) => [k, old[k as keyof typeof old]])),
        newValues: Object.fromEntries(changedKeys.map((k) => [k, next[k as keyof typeof next]])),
        reason: input.reason ?? p!.weightExceptionReason ?? null,
      });
      return this.load(tx, ctx, id);
    });
  }

  // ---------------------------------------------------------------- review (maker-checker)

  async review(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: ReviewSerialItemRequest,
    meta: RequestMeta,
  ): Promise<SerialItem> {
    this.requireFeature(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [item] = await tx
        .select()
        .from(serialItems)
        .where(and(eq(serialItems.tenantId, ctx.tenantId), eq(serialItems.id, id)))
        .for('update');
      if (!item) throw Errors.notFound('Serialized item');
      if (item.version !== input.version) throw Errors.versionConflict(item.version);
      if (item.status !== 'pending_review') {
        throw new AppError(
          409,
          'INVALID_STATE_TRANSITION',
          `Only items pending review can be reviewed (status: ${item.status})`,
        );
      }
      if (item.createdBy === auth.userId || item.updatedBy === auth.userId) {
        throw new AppError(
          403,
          'SEPARATION_OF_DUTIES',
          'A different person must review measurements you entered or changed',
        );
      }
      const status = input.decision === 'approve' ? 'active' : 'retired';
      await tx
        .update(serialItems)
        .set({
          status,
          reviewedBy: auth.userId,
          reviewedAt: new Date(),
          reviewNote: input.note,
          version: item.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(serialItems.id, id));
      await this.audit(
        tx,
        auth,
        ctx,
        meta,
        input.decision === 'approve' ? 'serial_item.exception_approved' : 'serial_item.exception_rejected',
        id,
        {
          oldValues: { status: item.status },
          newValues: {
            status,
            netG: item.netG,
            grossG: item.grossG,
            weightExceptionReason: item.weightExceptionReason,
          },
          reason: input.note,
        },
      );
      return this.load(tx, ctx, id);
    });
  }
}
