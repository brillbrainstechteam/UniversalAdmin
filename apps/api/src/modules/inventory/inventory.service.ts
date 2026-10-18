import { Injectable } from '@nestjs/common';
import {
  qty,
  qtyAdd,
  qtyCmp,
  qtyIsZero,
  qtyNeg,
  qtySub,
  type AdjustmentRequest,
  type ChannelStockLocations,
  type ConditionChangeRequest,
  type CreateReservationRequest,
  type CreateStockCountRequest,
  type CreateTransferRequest,
  type PutChannelLocationsRequest,
  type ReceiptRequest,
  type ReconcileResponse,
  type ReconciliationIssue,
  type ReleaseReservationRequest,
  type Reservation,
  type ResolveIssueRequest,
  type StockCount,
  type StockOperationResult,
  type StockSettings,
  type Transfer,
  type TransferActionRequest,
  type UpdateStockSettingsRequest,
  type UpdateVariantStockSettingsRequest,
  type VariantStockSettings,
  type WriteOffRequest,
} from '@uc/contracts';
import {
  InventoryError,
  assertQuantity,
  channels,
  channelStockLocations,
  commitReservation,
  enqueueEvent,
  findReservationByKey,
  loadStockProfile,
  locations,
  openIssue,
  postMovements,
  products,
  reconcileInventory,
  reconciliationIssues,
  releaseReservation,
  reserveStock,
  serialItems,
  setSerialState,
  stockBalances,
  stockCountLines,
  stockCounts,
  stockMovements,
  stockSettings,
  transferLines,
  transfers,
  variants,
  variantStockSettings,
  writeAudit,
  type MovementLine,
  type StockProfile,
  type Tx,
} from '@uc/db';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { AppError, Errors } from '../../common/errors';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';
import {
  assertScope,
  inScope,
  issueQuery,
  loadReservation,
  loadTransfer,
  locRef,
  operationMovements,
  requireInventory,
  toIssue,
  usableLocation,
} from './inventory.common';
import { loadCount, toSettings } from './inventory-query.service';

interface VariantInfo {
  id: string;
  sku: string;
  productType: string;
  profile: StockProfile;
}

const invalid = (path: string, message: string) => Errors.validation([{ path, message }]);

@Injectable()
export class InventoryService {
  constructor(private readonly db: DbService) {}

  private audit(
    tx: Tx,
    auth: AuthState,
    ctx: TenantState,
    meta: RequestMeta,
    action: string,
    entityType: string,
    entityId: string,
    values: {
      oldValues?: Record<string, unknown>;
      newValues?: Record<string, unknown>;
      reason?: string | null;
    },
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
      reason: values.reason ?? null,
      correlationId: meta.correlationId,
      ip: meta.ip,
    });
  }

  private async variantInfo(tx: Tx, ctx: TenantState, variantId: string, path: string): Promise<VariantInfo> {
    const [v] = await tx
      .select({ id: variants.id, sku: variants.sku, productType: products.productType })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(and(eq(variants.tenantId, ctx.tenantId), eq(variants.id, variantId)));
    if (!v) throw invalid(path, 'Unknown variant');
    return { ...v, profile: await loadStockProfile(tx, ctx.tenantId, variantId) };
  }

  private requireQuantityTracked(v: VariantInfo, path: string) {
    if (v.profile.tracking === 'serial') {
      throw invalid(
        path,
        `${v.sku} is tracked by piece: receive, transfer or write off the exact pieces instead`,
      );
    }
  }

  private async hasHistory(tx: Tx, tenantId: string, variantId: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: stockMovements.id })
      .from(stockMovements)
      .where(and(eq(stockMovements.tenantId, tenantId), eq(stockMovements.variantId, variantId)))
      .limit(1);
    return row !== undefined;
  }

  private async result(
    tx: Tx,
    ctx: TenantState,
    operationId: string,
    type: StockOperationResult['type'],
    reference: string | null,
  ) {
    return {
      operationId,
      type,
      reference,
      movements: await operationMovements(tx, ctx.tenantId, operationId),
    };
  }

  // ---------------------------------------------------------------- settings

  async updateSettings(
    auth: AuthState,
    ctx: TenantState,
    input: UpdateStockSettingsRequest,
    meta: RequestMeta,
  ): Promise<StockSettings> {
    requireInventory(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [before] = await tx
        .select()
        .from(stockSettings)
        .where(eq(stockSettings.tenantId, ctx.tenantId))
        .for('update');
      if (!before) throw Errors.notFound('Stock settings');
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      const [after] = await tx
        .update(stockSettings)
        .set({
          ...(input.defaultBuffer !== undefined ? { defaultBuffer: qty(input.defaultBuffer) } : {}),
          ...(input.reservationTtlMinutes !== undefined
            ? { reservationTtlMinutes: input.reservationTtlMinutes }
            : {}),
          ...(input.lowStockThreshold !== undefined
            ? { lowStockThreshold: qty(input.lowStockThreshold) }
            : {}),
          version: before.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(stockSettings.tenantId, ctx.tenantId))
        .returning();
      await this.audit(tx, auth, ctx, meta, 'inventory.settings_updated', 'stock_settings', ctx.tenantId, {
        oldValues: toSettings(before),
        newValues: toSettings(after!),
      });
      return toSettings(after!);
    });
  }

  async updateVariantSettings(
    auth: AuthState,
    ctx: TenantState,
    variantId: string,
    input: UpdateVariantStockSettingsRequest,
    meta: RequestMeta,
  ): Promise<VariantStockSettings> {
    requireInventory(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const v = await this.variantInfo(tx, ctx, variantId, 'variantId').catch(() => {
        throw Errors.notFound('Variant');
      });
      const [own] = await tx
        .select()
        .from(variantStockSettings)
        .where(
          and(eq(variantStockSettings.tenantId, ctx.tenantId), eq(variantStockSettings.variantId, variantId)),
        )
        .for('update');
      if ((own?.version ?? 0) !== input.version) throw Errors.versionConflict(own?.version ?? 0);
      const tracking = input.tracking ?? v.profile.tracking;
      const unit = input.unit ?? v.profile.unit;
      if (tracking !== v.profile.tracking || unit !== v.profile.unit) {
        if (await this.hasHistory(tx, ctx.tenantId, variantId)) {
          throw new AppError(
            409,
            'INVALID_STATE_TRANSITION',
            'Tracking and unit cannot change once the variant has stock history',
          );
        }
      }
      if (tracking === 'serial') {
        if (!ctx.features.includes('serialized_items')) throw Errors.featureNotEntitled('serialized_items');
        if (unit !== 'pcs') throw invalid('unit', 'Pieces are counted in pcs');
      }
      const values = {
        tracking,
        unit,
        buffer:
          input.buffer === undefined
            ? (own?.buffer ?? null)
            : input.buffer === null
              ? null
              : qty(input.buffer),
        lowStockThreshold:
          input.lowStockThreshold === undefined
            ? (own?.lowStockThreshold ?? null)
            : input.lowStockThreshold === null
              ? null
              : qty(input.lowStockThreshold),
      };
      if (own) {
        await tx
          .update(variantStockSettings)
          .set({ ...values, version: own.version + 1, updatedAt: new Date() })
          .where(
            and(
              eq(variantStockSettings.tenantId, ctx.tenantId),
              eq(variantStockSettings.variantId, variantId),
            ),
          );
      } else {
        await tx
          .insert(variantStockSettings)
          .values({ tenantId: ctx.tenantId, variantId, ...values, version: 1 });
      }
      await this.audit(tx, auth, ctx, meta, 'inventory.variant_settings_updated', 'variant', variantId, {
        oldValues: own
          ? {
              tracking: own.tracking,
              unit: own.unit,
              buffer: own.buffer,
              lowStockThreshold: own.lowStockThreshold,
            }
          : {},
        newValues: values,
      });
      const p = await loadStockProfile(tx, ctx.tenantId, variantId);
      return {
        tracking: p.tracking,
        unit: p.unit,
        buffer: values.buffer,
        lowStockThreshold: values.lowStockThreshold,
        effectiveBuffer: qty(p.buffer),
        effectiveLowStockThreshold: qty(p.lowStockThreshold),
        version: p.version,
      };
    });
  }

  async putChannelLocations(
    auth: AuthState,
    ctx: TenantState,
    channelId: string,
    input: PutChannelLocationsRequest,
    meta: RequestMeta,
  ): Promise<ChannelStockLocations> {
    requireInventory(ctx);
    if (ctx.locationScope !== null) {
      throw new AppError(
        403,
        'LOCATION_OUT_OF_SCOPE',
        'Only members without a location scope can change channel stock locations',
      );
    }
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [ch] = await tx
        .select()
        .from(channels)
        .where(and(eq(channels.tenantId, ctx.tenantId), eq(channels.id, channelId)));
      if (!ch) throw Errors.notFound('Channel');
      const ids = [...new Set(input.locationIds)];
      if (ids.length) {
        const found = await tx
          .select({ id: locations.id })
          .from(locations)
          .where(and(eq(locations.tenantId, ctx.tenantId), inArray(locations.id, ids)));
        if (found.length !== ids.length) throw invalid('locationIds', 'Unknown location');
      }
      const before = await tx
        .select()
        .from(channelStockLocations)
        .where(eq(channelStockLocations.channelId, channelId));
      await tx.delete(channelStockLocations).where(eq(channelStockLocations.channelId, channelId));
      if (ids.length) {
        await tx
          .insert(channelStockLocations)
          .values(ids.map((locationId) => ({ tenantId: ctx.tenantId, channelId, locationId })));
      }
      await this.audit(tx, auth, ctx, meta, 'channel.stock_locations_updated', 'channel', channelId, {
        oldValues: { locationIds: before.map((b) => b.locationId) },
        newValues: { locationIds: ids },
      });
      return { channelId, code: ch.code, name: ch.name, locationIds: ids };
    });
  }

  // ---------------------------------------------------------------- receipts / adjustments

  async receive(
    auth: AuthState,
    ctx: TenantState,
    input: ReceiptRequest,
    meta: RequestMeta,
  ): Promise<StockOperationResult> {
    requireInventory(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const loc = await usableLocation(tx, ctx, input.locationId);
      const lines: MovementLine[] = [];
      const pieceIds: string[] = [];
      for (const [i, line] of input.lines.entries()) {
        const path = `lines.${i}`;
        const v = await this.variantInfo(tx, ctx, line.variantId, `${path}.variantId`);
        if (line.quantity !== undefined) {
          this.requireQuantityTracked(v, `${path}.quantity`);
          assertQuantity(`${path}.quantity`, line.quantity, v.profile.unit);
          lines.push({
            variantId: v.id,
            locationId: loc.id,
            condition: input.condition,
            onHand: line.quantity,
            label: v.sku,
          });
          continue;
        }
        if (!ctx.features.includes('serialized_items')) throw Errors.featureNotEntitled('serialized_items');
        if (input.condition !== 'sellable')
          throw invalid('condition', 'Pieces are received as sellable stock');
        if (v.profile.tracking !== 'serial') {
          // First piece receipt switches an untouched variant to piece tracking.
          if (v.profile.hasSettingsRow || (await this.hasHistory(tx, ctx.tenantId, v.id))) {
            throw invalid(
              `${path}.serialItemIds`,
              `${v.sku} is tracked by quantity; set it to piece tracking first`,
            );
          }
          await tx
            .insert(variantStockSettings)
            .values({ tenantId: ctx.tenantId, variantId: v.id, tracking: 'serial', unit: 'pcs', version: 1 });
        }
        const ids = line.serialItemIds!;
        if (new Set(ids).size !== ids.length || ids.some((id) => pieceIds.includes(id))) {
          throw invalid(`${path}.serialItemIds`, 'A piece is listed twice');
        }
        const pieces = await tx
          .select()
          .from(serialItems)
          .where(and(eq(serialItems.tenantId, ctx.tenantId), inArray(serialItems.id, ids)));
        for (const id of ids) {
          const p = pieces.find((x) => x.id === id);
          if (!p || p.variantId !== v.id)
            throw invalid(`${path}.serialItemIds`, `Piece ${id} does not belong to ${v.sku}`);
          if (p.status !== 'active') {
            throw invalid(
              `${path}.serialItemIds`,
              `Piece ${p.serialTag} is ${p.status.replace('_', ' ')}; only active pieces can be received`,
            );
          }
          if (p.stockState !== 'not_received') {
            throw new AppError(
              409,
              'INVALID_STATE_TRANSITION',
              `Piece ${p.serialTag} is already ${p.stockState.replace('_', ' ')}`,
              {
                serialItemId: p.id,
              },
            );
          }
          lines.push({
            variantId: v.id,
            locationId: loc.id,
            condition: 'sellable',
            onHand: '1',
            serialItemId: p.id,
            label: p.serialTag,
          });
          pieceIds.push(p.id);
        }
      }
      const operationId = randomUUID();
      await postMovements(tx, {
        tenantId: ctx.tenantId,
        type: 'receipt',
        operationId,
        lines,
        reference: input.reference ?? null,
        note: input.note ?? null,
        actorUserId: auth.userId,
        correlationId: meta.correlationId,
      });
      await setSerialState(tx, ctx.tenantId, pieceIds, ['not_received'], 'in_stock', loc.id);
      await this.audit(tx, auth, ctx, meta, 'inventory.received', 'stock_operation', operationId, {
        newValues: {
          location: loc.code,
          condition: input.condition,
          reference: input.reference ?? null,
          lines: input.lines,
        },
      });
      return this.result(tx, ctx, operationId, 'receipt', input.reference ?? null);
    });
  }

  async adjust(
    auth: AuthState,
    ctx: TenantState,
    input: AdjustmentRequest,
    meta: RequestMeta,
  ): Promise<StockOperationResult> {
    requireInventory(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const loc = await usableLocation(tx, ctx, input.locationId);
      const lines: MovementLine[] = [];
      for (const [i, line] of input.lines.entries()) {
        const v = await this.variantInfo(tx, ctx, line.variantId, `lines.${i}.variantId`);
        this.requireQuantityTracked(v, `lines.${i}.variantId`);
        assertQuantity(`lines.${i}.delta`, line.delta, v.profile.unit, { signed: true });
        lines.push({
          variantId: v.id,
          locationId: loc.id,
          condition: input.condition,
          onHand: line.delta,
          label: v.sku,
        });
      }
      const operationId = randomUUID();
      await postMovements(tx, {
        tenantId: ctx.tenantId,
        type: 'adjustment',
        operationId,
        lines,
        reasonCode: input.reasonCode,
        note: input.note,
        reference: input.reference ?? null,
        actorUserId: auth.userId,
        correlationId: meta.correlationId,
      });
      await this.audit(tx, auth, ctx, meta, 'inventory.adjusted', 'stock_operation', operationId, {
        newValues: {
          location: loc.code,
          condition: input.condition,
          reasonCode: input.reasonCode,
          lines: input.lines,
        },
        reason: input.note,
      });
      return this.result(tx, ctx, operationId, 'adjustment', input.reference ?? null);
    });
  }

  async changeCondition(
    auth: AuthState,
    ctx: TenantState,
    input: ConditionChangeRequest,
    meta: RequestMeta,
  ): Promise<StockOperationResult> {
    requireInventory(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const loc = await usableLocation(tx, ctx, input.locationId);
      const v = await this.variantInfo(tx, ctx, input.variantId, 'variantId');
      this.requireQuantityTracked(v, 'variantId');
      assertQuantity('quantity', input.quantity, v.profile.unit);
      const operationId = randomUUID();
      await postMovements(tx, {
        tenantId: ctx.tenantId,
        type: 'condition_change',
        operationId,
        note: input.note,
        reasonCode: `${input.from}_to_${input.to}`,
        actorUserId: auth.userId,
        correlationId: meta.correlationId,
        lines: [
          {
            variantId: v.id,
            locationId: loc.id,
            condition: input.from,
            onHand: qtyNeg(input.quantity),
            label: v.sku,
          },
          { variantId: v.id, locationId: loc.id, condition: input.to, onHand: input.quantity, label: v.sku },
        ],
      });
      await this.audit(tx, auth, ctx, meta, 'inventory.condition_changed', 'stock_operation', operationId, {
        newValues: {
          location: loc.code,
          sku: v.sku,
          from: input.from,
          to: input.to,
          quantity: input.quantity,
        },
        reason: input.note,
      });
      return this.result(tx, ctx, operationId, 'condition_change', null);
    });
  }

  async writeOff(
    auth: AuthState,
    ctx: TenantState,
    serialItemId: string,
    input: WriteOffRequest,
    meta: RequestMeta,
  ): Promise<StockOperationResult> {
    requireInventory(ctx);
    if (!ctx.features.includes('serialized_items')) throw Errors.featureNotEntitled('serialized_items');
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [piece] = await tx
        .select()
        .from(serialItems)
        .where(and(eq(serialItems.tenantId, ctx.tenantId), eq(serialItems.id, serialItemId)));
      if (!piece) throw Errors.notFound('Serialized item');
      if (piece.stockState !== 'in_stock' || !piece.locationId) {
        throw new AppError(
          409,
          'INVALID_STATE_TRANSITION',
          `Only pieces in stock can be written off (this one is ${piece.stockState.replace('_', ' ')}); release holds or receive transfers first`,
          { stockState: piece.stockState },
        );
      }
      assertScope(ctx, piece.locationId);
      const operationId = randomUUID();
      await postMovements(tx, {
        tenantId: ctx.tenantId,
        type: 'write_off',
        operationId,
        reasonCode: 'write_off',
        note: input.reason,
        actorUserId: auth.userId,
        correlationId: meta.correlationId,
        lines: [
          {
            variantId: piece.variantId,
            locationId: piece.locationId,
            condition: 'sellable',
            onHand: '-1',
            serialItemId: piece.id,
            label: piece.serialTag,
          },
        ],
      });
      await setSerialState(tx, ctx.tenantId, [piece.id], ['in_stock'], 'written_off', null);
      await this.audit(tx, auth, ctx, meta, 'serial_item.written_off', 'serial_item', piece.id, {
        oldValues: { stockState: piece.stockState, locationId: piece.locationId },
        newValues: { stockState: 'written_off' },
        reason: input.reason,
      });
      return this.result(tx, ctx, operationId, 'write_off', null);
    });
  }

  // ---------------------------------------------------------------- reservations

  async reserve(
    auth: AuthState,
    ctx: TenantState,
    input: CreateReservationRequest,
    key: string | undefined,
    meta: RequestMeta,
  ): Promise<{ reservation: Reservation; replayed: boolean }> {
    requireInventory(ctx);
    if (!key) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
    if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) {
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        'Idempotency-Key must be 8-128 characters [A-Za-z0-9_.:-]',
      );
    }
    if (input.locationId) assertScope(ctx, input.locationId);
    const run = () =>
      this.db.tenant(ctx.tenantId, async (tx) => {
        await this.variantInfo(tx, ctx, input.variantId, 'variantId');
        if (input.channelId) {
          const [ch] = await tx
            .select()
            .from(channels)
            .where(and(eq(channels.tenantId, ctx.tenantId), eq(channels.id, input.channelId)));
          if (!ch || ch.status !== 'active') throw invalid('channelId', 'Unknown or inactive channel');
        }
        const { reservation, replayed } = await reserveStock(tx, {
          tenantId: ctx.tenantId,
          variantId: input.variantId,
          quantity: input.quantity,
          locationId: input.locationId,
          serialItemId: input.serialItemId,
          channelId: input.channelId,
          referenceType: input.referenceType,
          referenceId: input.referenceId ?? null,
          ttlMinutes: input.ttlMinutes,
          note: input.note ?? null,
          idempotencyKey: key,
          actorUserId: auth.userId,
          correlationId: meta.correlationId,
          allowedLocationIds: ctx.locationScope,
        });
        if (!replayed) {
          await this.audit(tx, auth, ctx, meta, 'reservation.created', 'reservation', reservation.id, {
            newValues: {
              variantId: reservation.variantId,
              locationId: reservation.locationId,
              serialItemId: reservation.serialItemId,
              quantity: reservation.quantity,
              expiresAt: reservation.expiresAt?.toISOString(),
              referenceType: reservation.referenceType,
            },
          });
        }
        if (!inScope(ctx, reservation.locationId)) throw Errors.notFound('Reservation');
        return { reservation: await loadReservation(tx, ctx.tenantId, reservation.id), replayed };
      });
    try {
      return await run();
    } catch (error) {
      // Same key raced in parallel: the loser's insert hit the unique key after the winner committed.
      const pg = ((error as { cause?: { code?: string; constraint?: string } }).cause ?? error) as {
        code?: string;
        constraint?: string;
      };
      if (pg.code === '23505' && pg.constraint === 'reservations_idempotency_uq') {
        const existing = await this.db.tenant(ctx.tenantId, (tx) =>
          findReservationByKey(tx, ctx.tenantId, key),
        );
        if (existing) return run();
      }
      throw error;
    }
  }

  private async reservationInScope(tx: Tx, ctx: TenantState, id: string) {
    const r = await loadReservation(tx, ctx.tenantId, id);
    if (!inScope(ctx, r.location.id)) throw Errors.notFound('Reservation');
    return r;
  }

  async commit(auth: AuthState, ctx: TenantState, id: string, meta: RequestMeta): Promise<Reservation> {
    requireInventory(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await this.reservationInScope(tx, ctx, id);
      const r = await commitReservation(tx, {
        tenantId: ctx.tenantId,
        reservationId: id,
        actorUserId: auth.userId,
        correlationId: meta.correlationId,
      });
      await this.audit(tx, auth, ctx, meta, 'reservation.committed', 'reservation', id, {
        oldValues: { status: 'held' },
        newValues: { status: r.status, quantity: r.quantity },
      });
      return loadReservation(tx, ctx.tenantId, id);
    });
  }

  async release(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: ReleaseReservationRequest,
    meta: RequestMeta,
  ): Promise<Reservation> {
    requireInventory(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const before = await this.reservationInScope(tx, ctx, id);
      const r = await releaseReservation(tx, {
        tenantId: ctx.tenantId,
        reservationId: id,
        actorUserId: auth.userId,
        reason: input.reason ?? null,
        correlationId: meta.correlationId,
      });
      await this.audit(tx, auth, ctx, meta, 'reservation.released', 'reservation', id, {
        oldValues: { status: before.status },
        newValues: { status: r.status, quantity: r.quantity },
        reason: input.reason ?? null,
      });
      return loadReservation(tx, ctx.tenantId, id);
    });
  }

  // ---------------------------------------------------------------- transfers

  async createTransfer(
    auth: AuthState,
    ctx: TenantState,
    input: CreateTransferRequest,
    meta: RequestMeta,
  ): Promise<Transfer> {
    requireInventory(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const from = await usableLocation(tx, ctx, input.fromLocationId, 'fromLocationId');
      const [to] = await tx
        .select()
        .from(locations)
        .where(and(eq(locations.tenantId, ctx.tenantId), eq(locations.id, input.toLocationId)));
      if (!to) throw invalid('toLocationId', 'Unknown location');
      if (to.status !== 'active') throw invalid('toLocationId', `Location ${to.name} is inactive`);

      const id = randomUUID();
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`transfer-number:${ctx.tenantId}`}))`);
      const [last] = await tx
        .select({ n: sql<number>`coalesce(max(substring(${transfers.number} from 4)::int), 0)::int` })
        .from(transfers)
        .where(and(eq(transfers.tenantId, ctx.tenantId), sql`${transfers.number} ~ '^TR-[0-9]+$'`));
      const number = `TR-${String((last?.n ?? 0) + 1).padStart(6, '0')}`;

      const lineRows: (typeof transferLines.$inferInsert)[] = [];
      const moves: MovementLine[] = [];
      const pieceIds: string[] = [];
      for (const [i, line] of input.lines.entries()) {
        const path = `lines.${i}`;
        const v = await this.variantInfo(tx, ctx, line.variantId, `${path}.variantId`);
        if (line.quantity !== undefined) {
          this.requireQuantityTracked(v, `${path}.quantity`);
          assertQuantity(`${path}.quantity`, line.quantity, v.profile.unit);
          lineRows.push({
            tenantId: ctx.tenantId,
            transferId: id,
            variantId: v.id,
            quantity: qty(line.quantity),
          });
          moves.push(
            {
              variantId: v.id,
              locationId: from.id,
              condition: 'sellable',
              onHand: qtyNeg(line.quantity),
              label: v.sku,
            },
            {
              variantId: v.id,
              locationId: to.id,
              condition: 'in_transit',
              onHand: line.quantity,
              label: v.sku,
            },
          );
          continue;
        }
        const [p] = await tx
          .select()
          .from(serialItems)
          .where(and(eq(serialItems.tenantId, ctx.tenantId), eq(serialItems.id, line.serialItemId!)));
        if (!p || p.variantId !== v.id)
          throw invalid(`${path}.serialItemId`, `Piece does not belong to ${v.sku}`);
        if (pieceIds.includes(p.id)) throw invalid(`${path}.serialItemId`, 'A piece is listed twice');
        if (p.stockState !== 'in_stock' || p.locationId !== from.id) {
          throw new AppError(
            409,
            'INVALID_STATE_TRANSITION',
            `Piece ${p.serialTag} is not in stock at ${from.name}`,
            {
              stockState: p.stockState,
            },
          );
        }
        pieceIds.push(p.id);
        lineRows.push({
          tenantId: ctx.tenantId,
          transferId: id,
          variantId: v.id,
          serialItemId: p.id,
          quantity: '1',
        });
        moves.push(
          {
            variantId: v.id,
            locationId: from.id,
            condition: 'sellable',
            onHand: '-1',
            serialItemId: p.id,
            label: p.serialTag,
          },
          {
            variantId: v.id,
            locationId: to.id,
            condition: 'in_transit',
            onHand: '1',
            serialItemId: p.id,
            label: p.serialTag,
          },
        );
      }
      await tx.insert(transfers).values({
        id,
        tenantId: ctx.tenantId,
        number,
        fromLocationId: from.id,
        toLocationId: to.id,
        note: input.note ?? null,
        createdBy: auth.userId,
      });
      await tx.insert(transferLines).values(lineRows);
      await postMovements(tx, {
        tenantId: ctx.tenantId,
        type: 'transfer_dispatch',
        reference: number,
        lines: moves,
        note: input.note ?? null,
        actorUserId: auth.userId,
        correlationId: meta.correlationId,
      });
      await setSerialState(tx, ctx.tenantId, pieceIds, ['in_stock'], 'in_transit', to.id);
      await this.audit(tx, auth, ctx, meta, 'transfer.dispatched', 'transfer', id, {
        newValues: { number, from: from.code, to: to.code, lines: input.lines },
      });
      return loadTransfer(tx, ctx.tenantId, id);
    });
  }

  private async lockTransfer(tx: Tx, ctx: TenantState, id: string, version: number) {
    const [t] = await tx
      .select()
      .from(transfers)
      .where(and(eq(transfers.tenantId, ctx.tenantId), eq(transfers.id, id)))
      .for('update');
    if (!t || (!inScope(ctx, t.fromLocationId) && !inScope(ctx, t.toLocationId)))
      throw Errors.notFound('Transfer');
    if (t.version !== version) throw Errors.versionConflict(t.version);
    if (t.status !== 'in_transit') {
      throw new AppError(409, 'INVALID_STATE_TRANSITION', `Transfer ${t.number} is already ${t.status}`);
    }
    const lines = await tx.select().from(transferLines).where(eq(transferLines.transferId, id));
    return { t, lines };
  }

  async receiveTransfer(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: TransferActionRequest,
    meta: RequestMeta,
  ): Promise<Transfer> {
    requireInventory(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const { t, lines } = await this.lockTransfer(tx, ctx, id, input.version);
      assertScope(ctx, t.toLocationId);
      await postMovements(tx, {
        tenantId: ctx.tenantId,
        type: 'transfer_receive',
        reference: t.number,
        note: input.note ?? null,
        actorUserId: auth.userId,
        correlationId: meta.correlationId,
        lines: lines.flatMap((l) => [
          {
            variantId: l.variantId,
            locationId: t.toLocationId,
            condition: 'in_transit' as const,
            onHand: qtyNeg(l.quantity),
            serialItemId: l.serialItemId,
          },
          {
            variantId: l.variantId,
            locationId: t.toLocationId,
            condition: 'sellable' as const,
            onHand: l.quantity,
            serialItemId: l.serialItemId,
          },
        ]),
      });
      const pieces = lines.map((l) => l.serialItemId).filter((x): x is string => x !== null);
      await setSerialState(tx, ctx.tenantId, pieces, ['in_transit'], 'in_stock', t.toLocationId);
      await tx
        .update(transfers)
        .set({ status: 'received', receivedBy: auth.userId, receivedAt: new Date(), version: t.version + 1 })
        .where(eq(transfers.id, id));
      await this.audit(tx, auth, ctx, meta, 'transfer.received', 'transfer', id, {
        oldValues: { status: 'in_transit' },
        newValues: { status: 'received' },
        reason: input.note ?? null,
      });
      return loadTransfer(tx, ctx.tenantId, id);
    });
  }

  async cancelTransfer(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: TransferActionRequest,
    meta: RequestMeta,
  ): Promise<Transfer> {
    requireInventory(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const { t, lines } = await this.lockTransfer(tx, ctx, id, input.version);
      assertScope(ctx, t.fromLocationId);
      await postMovements(tx, {
        tenantId: ctx.tenantId,
        type: 'transfer_cancel',
        reference: t.number,
        note: input.note ?? null,
        actorUserId: auth.userId,
        correlationId: meta.correlationId,
        lines: lines.flatMap((l) => [
          {
            variantId: l.variantId,
            locationId: t.toLocationId,
            condition: 'in_transit' as const,
            onHand: qtyNeg(l.quantity),
            serialItemId: l.serialItemId,
          },
          {
            variantId: l.variantId,
            locationId: t.fromLocationId,
            condition: 'sellable' as const,
            onHand: l.quantity,
            serialItemId: l.serialItemId,
          },
        ]),
      });
      const pieces = lines.map((l) => l.serialItemId).filter((x): x is string => x !== null);
      await setSerialState(tx, ctx.tenantId, pieces, ['in_transit'], 'in_stock', t.fromLocationId);
      await tx
        .update(transfers)
        .set({ status: 'cancelled', version: t.version + 1 })
        .where(eq(transfers.id, id));
      await this.audit(tx, auth, ctx, meta, 'transfer.cancelled', 'transfer', id, {
        oldValues: { status: 'in_transit' },
        newValues: { status: 'cancelled' },
        reason: input.note ?? null,
      });
      return loadTransfer(tx, ctx.tenantId, id);
    });
  }

  // ---------------------------------------------------------------- stocktakes

  async count(
    auth: AuthState,
    ctx: TenantState,
    input: CreateStockCountRequest,
    meta: RequestMeta,
  ): Promise<StockCount> {
    requireInventory(ctx);
    const asOf = new Date(input.asOf);
    if (asOf.getTime() > Date.now() + 5 * 60_000)
      throw invalid('asOf', 'The count time cannot be in the future');
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const loc = await usableLocation(tx, ctx, input.locationId);
      const seen = new Set<string>();
      const infos: VariantInfo[] = [];
      for (const [i, line] of input.lines.entries()) {
        if (seen.has(line.variantId)) throw invalid(`lines.${i}.variantId`, 'Variant is counted twice');
        seen.add(line.variantId);
        const v = await this.variantInfo(tx, ctx, line.variantId, `lines.${i}.variantId`);
        if (v.profile.tracking === 'serial') {
          throw invalid(
            `lines.${i}.variantId`,
            `${v.sku} is tracked by piece; check pieces in Serialized items instead`,
          );
        }
        assertQuantity(`lines.${i}.counted`, line.counted, v.profile.unit, { allowZero: true });
        infos.push(v);
      }
      // Serialize counts per location so the as-of ordering check cannot race.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stock-count:${loc.id}`}))`);
      const variantIds = infos.map((v) => v.id);
      const balances = await tx
        .select()
        .from(stockBalances)
        .where(
          and(
            eq(stockBalances.tenantId, ctx.tenantId),
            inArray(stockBalances.variantId, variantIds),
            eq(stockBalances.locationId, loc.id),
            eq(stockBalances.condition, 'sellable'),
          ),
        )
        .orderBy(asc(stockBalances.variantId))
        .for('update');
      const lines = input.lines.map((l, i) => {
        const b = balances.find((x) => x.variantId === l.variantId);
        const expected = qty(b?.onHand ?? '0');
        return {
          variantId: l.variantId,
          sku: infos[i]!.sku,
          counted: qty(l.counted),
          expected,
          variance: qtySub(l.counted, expected),
          held: qtyAdd(b?.reserved ?? '0', b?.committed ?? '0'),
        };
      });
      const view = (status: StockCount['status'], id: string | null, issueId: string | null): StockCount => ({
        id,
        location: locRef(loc),
        source: input.source,
        sourceVersion: input.sourceVersion ?? null,
        asOf: asOf.toISOString(),
        status,
        reference: input.reference ?? null,
        note: input.note ?? null,
        operationId: status === 'applied' ? id : null,
        issueId,
        lines: lines.map(({ held: _held, ...l }) => l),
        createdBy: { id: auth.userId, name: auth.displayName },
        createdAt: id ? new Date().toISOString() : null,
      });
      if (input.dryRun) return view('preview', null, null);

      const [newer] = await tx
        .select({ id: stockCounts.id, asOf: stockCounts.asOf })
        .from(stockCounts)
        .where(
          and(
            eq(stockCounts.tenantId, ctx.tenantId),
            eq(stockCounts.locationId, loc.id),
            eq(stockCounts.source, input.source),
            eq(stockCounts.status, 'applied'),
            gte(stockCounts.asOf, asOf),
          ),
        )
        .orderBy(desc(stockCounts.asOf))
        .limit(1);
      const stale = newer !== undefined;
      if (!stale) {
        const short = lines.filter((l) => qtyCmp(l.counted, l.held) < 0);
        if (short.length) {
          throw new InventoryError(
            409,
            'INSUFFICIENT_STOCK',
            'Counted stock is below what is reserved or committed; release holds first',
            {
              lines: short.map((l) => ({ sku: l.sku, counted: l.counted, reservedOrCommitted: l.held })),
            },
          );
        }
      }
      const id = randomUUID();
      await tx.insert(stockCounts).values({
        id,
        tenantId: ctx.tenantId,
        locationId: loc.id,
        source: input.source,
        sourceVersion: input.sourceVersion ?? null,
        asOf,
        status: stale ? 'rejected_stale' : 'applied',
        reference: input.reference ?? null,
        note: input.note ?? null,
        createdBy: auth.userId,
      });
      await tx.insert(stockCountLines).values(
        lines.map((l) => ({
          tenantId: ctx.tenantId,
          countId: id,
          variantId: l.variantId,
          counted: l.counted,
          expected: l.expected,
          variance: l.variance,
        })),
      );
      if (stale) {
        // The issue id is surfaced on the count through loadCount (dedupe key stale:<countId>).
        await openIssue(tx, {
          tenantId: ctx.tenantId,
          kind: 'stale_snapshot',
          severity: 'warning',
          locationId: loc.id,
          dedupeKey: `stale:${id}`,
          correlationId: meta.correlationId,
          details: {
            countId: id,
            asOf: asOf.toISOString(),
            newerCountId: newer.id,
            newerAsOf: newer.asOf.toISOString(),
            source: input.source,
          },
        });
      } else {
        await postMovements(tx, {
          tenantId: ctx.tenantId,
          type: 'stocktake',
          operationId: id,
          reference: input.reference ?? null,
          reasonCode: input.source,
          note: input.note ?? null,
          actorUserId: auth.userId,
          correlationId: meta.correlationId,
          lines: lines
            .filter((l) => !qtyIsZero(l.variance))
            .map((l) => ({
              variantId: l.variantId,
              locationId: loc.id,
              condition: 'sellable' as const,
              onHand: l.variance,
              label: l.sku,
            })),
        });
      }
      await enqueueEvent(tx, {
        tenantId: ctx.tenantId,
        eventType: 'InventorySnapshotReceived',
        aggregateType: 'stock_count',
        aggregateId: id,
        correlationId: meta.correlationId,
        payload: {
          countId: id,
          locationId: loc.id,
          source: input.source,
          asOf: asOf.toISOString(),
          status: stale ? 'rejected_stale' : 'applied',
          lines: lines.map((l) => ({
            variantId: l.variantId,
            counted: l.counted,
            expected: l.expected,
            variance: l.variance,
          })),
        },
      });
      await this.audit(
        tx,
        auth,
        ctx,
        meta,
        stale ? 'inventory.count_rejected_stale' : 'inventory.counted',
        'stock_count',
        id,
        {
          newValues: {
            location: loc.code,
            asOf: asOf.toISOString(),
            source: input.source,
            lines: lines.length,
          },
        },
      );
      return loadCount(tx, ctx, id);
    });
  }

  // ---------------------------------------------------------------- reconciliation

  async reconcile(auth: AuthState, ctx: TenantState, meta: RequestMeta): Promise<ReconcileResponse> {
    requireInventory(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const result = await reconcileInventory(tx, { tenantId: ctx.tenantId });
      await this.audit(tx, auth, ctx, meta, 'inventory.reconciled', 'tenant', ctx.tenantId, {
        newValues: { ...result },
      });
      return result;
    });
  }

  async resolveIssue(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: ResolveIssueRequest,
    meta: RequestMeta,
  ): Promise<ReconciliationIssue> {
    requireInventory(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [issue] = await tx
        .select()
        .from(reconciliationIssues)
        .where(and(eq(reconciliationIssues.tenantId, ctx.tenantId), eq(reconciliationIssues.id, id)))
        .for('update');
      if (!issue || (issue.locationId && !inScope(ctx, issue.locationId))) throw Errors.notFound('Issue');
      if (issue.status !== 'open')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', 'Issue is already resolved');
      await tx
        .update(reconciliationIssues)
        .set({
          status: 'resolved',
          resolvedBy: auth.userId,
          resolutionNote: input.note,
          resolvedAt: new Date(),
        })
        .where(eq(reconciliationIssues.id, id));
      await enqueueEvent(tx, {
        tenantId: ctx.tenantId,
        eventType: 'ReconciliationIssueResolved',
        aggregateType: 'reconciliation_issue',
        aggregateId: id,
        correlationId: meta.correlationId,
        payload: { issueId: id, domain: issue.domain, kind: issue.kind, note: input.note },
      });
      await this.audit(tx, auth, ctx, meta, 'reconciliation_issue.resolved', 'reconciliation_issue', id, {
        oldValues: { status: 'open' },
        newValues: { status: 'resolved' },
        reason: input.note,
      });
      const [row] = await issueQuery(tx).where(eq(reconciliationIssues.id, id));
      return toIssue(row!);
    });
  }
}
