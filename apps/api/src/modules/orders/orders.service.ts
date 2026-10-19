import { Injectable } from '@nestjs/common';
import type {
  ApproveOrderRequest,
  CancelOrderRequest,
  CreateOrderRequest,
  Order,
  OrderListQuery,
  OrderSettings,
  OrderSummary,
  Page,
  RejectOrderRequest,
  UpdateOrderSettingsRequest,
} from '@uc/contracts';
import {
  cancelOrder,
  channels,
  confirmOrder,
  diff,
  orderLines,
  orderSettings,
  orders,
  writeAudit,
  type Tx,
} from '@uc/db';
import { and, desc, eq, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import { decodeCursor, paginate } from '../../common/cursor';
import { AppError, Errors } from '../../common/errors';
import { likePattern } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';
import { QuoteService } from '../pricing/quote.service';
import {
  loadOrder,
  loadOrderSettings,
  placeOrder,
  requireOrders,
  toOrder,
  toOrderSettings,
  toSummary,
} from './orders.common';

/** Approval window for orders waiting on a second person (holds last this long). */
export const APPROVAL_HOLD_MINUTES = 24 * 60;

@Injectable()
export class OrdersService {
  constructor(
    private readonly db: DbService,
    private readonly quotes: QuoteService,
  ) {}

  private audit(
    tx: Tx,
    auth: AuthState,
    ctx: TenantState,
    meta: RequestMeta,
    action: string,
    id: string,
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
      entityType: 'order',
      entityId: id,
      oldValues: values.oldValues ?? null,
      newValues: values.newValues ?? null,
      reason: values.reason ?? null,
      correlationId: meta.correlationId,
      ip: meta.ip,
    });
  }

  // ---------------------------------------------------------------- settings

  async settings(ctx: TenantState): Promise<OrderSettings> {
    requireOrders(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) =>
      toOrderSettings(await loadOrderSettings(tx, ctx.tenantId)),
    );
  }

  async updateSettings(
    auth: AuthState,
    ctx: TenantState,
    input: UpdateOrderSettingsRequest,
    meta: RequestMeta,
  ) {
    requireOrders(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await loadOrderSettings(tx, ctx.tenantId);
      const [before] = await tx
        .select()
        .from(orderSettings)
        .where(eq(orderSettings.tenantId, ctx.tenantId))
        .for('update');
      if (before!.version !== input.version) throw Errors.versionConflict(before!.version);
      const { version, approvalThresholdMinor, ...rest } = input;
      const [after] = await tx
        .update(orderSettings)
        .set({
          ...rest,
          ...(approvalThresholdMinor !== undefined
            ? {
                approvalThresholdMinor:
                  approvalThresholdMinor === null ? null : BigInt(approvalThresholdMinor),
              }
            : {}),
          version: version + 1,
          updatedAt: new Date(),
        })
        .where(eq(orderSettings.tenantId, ctx.tenantId))
        .returning();
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: 'orders.settings_updated',
        entityType: 'order_settings',
        entityId: ctx.tenantId,
        ...diff(toOrderSettings(before!), toOrderSettings(after!)),
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return toOrderSettings(after!);
    });
  }

  // ---------------------------------------------------------------- read

  async list(ctx: TenantState, q: OrderListQuery): Promise<Page<OrderSummary>> {
    requireOrders(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const where: (SQL | undefined)[] = [
        eq(orders.tenantId, ctx.tenantId),
        q.status ? eq(orders.status, q.status) : undefined,
        q.paymentStatus ? eq(orders.paymentStatus, q.paymentStatus) : undefined,
        q.channelId ? eq(orders.channelId, q.channelId) : undefined,
        q.origin ? eq(orders.origin, q.origin) : undefined,
      ];
      if (q.q)
        where.push(
          or(
            ilike(orders.number, likePattern(q.q)),
            sql`${orders.contact}->>'email' ilike ${likePattern(q.q)}`,
            sql`${orders.contact}->>'name' ilike ${likePattern(q.q)}`,
          ),
        );
      if (cursor) {
        const at = new Date(String(cursor.sortValue));
        where.push(or(lt(orders.createdAt, at), and(eq(orders.createdAt, at), lt(orders.id, cursor.id))));
      }
      const rows = await tx
        .select({
          o: orders,
          channelName: channels.name,
          lineCount: sql<number>`(select count(*)::int from ${orderLines} l where l.order_id = ${orders.id})`,
        })
        .from(orders)
        .leftJoin(channels, eq(channels.id, orders.channelId))
        .where(and(...where))
        .orderBy(desc(orders.createdAt), desc(orders.id))
        .limit(q.limit + 1);
      return paginate(
        rows.map((r) => toSummary(r.o, r.channelName, r.lineCount)),
        q.limit,
        (r) => r.createdAt,
      );
    });
  }

  async get(ctx: TenantState, id: string): Promise<Order> {
    requireOrders(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => toOrder(tx, await loadOrder(tx, ctx.tenantId, id)));
  }

  // ---------------------------------------------------------------- write

  /** Staff order on account: priced by the server, held, then confirmed or sent for approval. */
  async create(
    auth: AuthState,
    ctx: TenantState,
    input: CreateOrderRequest,
    meta: RequestMeta,
  ): Promise<Order> {
    requireOrders(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const settings = await loadOrderSettings(tx, ctx.tenantId);
      const scope = await this.quotes.scope(tx, ctx, input.channelId, false);
      const priced = await this.quotes.priceLines(tx, scope, input.lines);
      const quote = await this.quotes.insertQuote(tx, scope, input.lines, priced, 'admin', auth.userId);
      const needsApproval =
        settings.approvalThresholdMinor !== null && priced.totalMinor >= settings.approvalThresholdMinor;
      const order = await placeOrder(tx, {
        tenantId: ctx.tenantId,
        channelId: input.channelId,
        origin: 'admin',
        paymentTerms: 'on_account',
        contact: input.contact,
        shippingAddress: input.shippingAddress,
        note: input.note,
        priced: priced.priced,
        currency: priced.currency,
        subtotalMinor: priced.subtotalMinor,
        discountMinor: priced.discountMinor,
        taxMinor: priced.taxMinor,
        totalMinor: priced.totalMinor,
        priceQuoteId: quote.id,
        next: needsApproval ? 'awaiting_approval' : 'confirm',
        holdMinutes: needsApproval ? APPROVAL_HOLD_MINUTES : settings.checkoutHoldMinutes,
        actorUserId: auth.userId,
        correlationId: meta.correlationId,
        now: scope.now,
      });
      await this.audit(tx, auth, ctx, meta, 'order.created', order.id, {
        newValues: {
          number: order.number,
          status: order.status,
          totalMinor: order.totalMinor.toString(),
          currency: order.currency,
          lines: input.lines.length,
        },
      });
      return toOrder(tx, order);
    });
  }

  async approve(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: ApproveOrderRequest,
    meta: RequestMeta,
  ): Promise<Order> {
    requireOrders(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const order = await loadOrder(tx, ctx.tenantId, id, true);
      if (order.status !== 'awaiting_approval')
        throw new AppError(
          409,
          'INVALID_STATE_TRANSITION',
          `Order ${order.number} is ${order.status.replace('_', ' ')}`,
        );
      if (order.createdBy === auth.userId)
        throw new AppError(
          403,
          'SEPARATION_OF_DUTIES',
          'You created this order; another approver must approve it',
        );
      const now = new Date();
      await tx
        .update(orders)
        .set({ approvedBy: auth.userId, approvedAt: now, updatedAt: now })
        .where(eq(orders.id, order.id));
      const { order: after, warnings } = await confirmOrder(
        tx,
        { ...order, approvedBy: auth.userId, approvedAt: now },
        {
          actorUserId: auth.userId,
          correlationId: meta.correlationId,
          note: input.note ?? 'Approved',
          now,
        },
      );
      await this.audit(tx, auth, ctx, meta, 'order.approved', order.id, {
        oldValues: { status: order.status },
        newValues: { status: after.status, warnings },
        reason: input.note ?? null,
      });
      return toOrder(tx, after);
    });
  }

  async reject(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: RejectOrderRequest,
    meta: RequestMeta,
  ): Promise<Order> {
    requireOrders(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const order = await loadOrder(tx, ctx.tenantId, id, true);
      if (order.status !== 'awaiting_approval')
        throw new AppError(
          409,
          'INVALID_STATE_TRANSITION',
          `Order ${order.number} is ${order.status.replace('_', ' ')}`,
        );
      const after = await cancelOrder(tx, order, {
        actorUserId: auth.userId,
        correlationId: meta.correlationId,
        reason: input.reason,
        type: 'rejected',
      });
      await this.audit(tx, auth, ctx, meta, 'order.rejected', order.id, {
        oldValues: { status: order.status },
        newValues: { status: after.status },
        reason: input.reason,
      });
      return toOrder(tx, after);
    });
  }

  async cancel(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: CancelOrderRequest,
    meta: RequestMeta,
  ): Promise<Order> {
    requireOrders(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const order = await loadOrder(tx, ctx.tenantId, id, true);
      const after = await cancelOrder(tx, order, {
        actorUserId: auth.userId,
        correlationId: meta.correlationId,
        reason: input.reason,
      });
      await this.audit(tx, auth, ctx, meta, 'order.cancelled', order.id, {
        oldValues: { status: order.status, paymentStatus: order.paymentStatus },
        newValues: {
          status: after.status,
          paymentStatus: after.paymentStatus,
          refundDueMinor: after.refundDueMinor.toString(),
        },
        reason: input.reason,
      });
      return toOrder(tx, after);
    });
  }
}
