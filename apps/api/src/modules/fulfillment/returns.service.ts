import { Injectable } from '@nestjs/common';
import type {
  CreateReturnRequest,
  DecideReturnRequest,
  OrderReturn,
  Page,
  ReceiveReturnRequest,
  ReturnListQuery,
} from '@uc/contracts';
import {
  addOrderEvent,
  enqueueEvent,
  locations,
  nextDocumentNumber,
  orderLines,
  orders,
  receiveReturnStock,
  recordCustomerMessage,
  returnLines,
  returns,
  shipments,
  writeAudit,
  type OrderRow,
  type Tx,
} from '@uc/db';
import { and, asc, desc, eq, inArray, lt, or, type SQL } from 'drizzle-orm';
import { decodeCursor, paginate } from '../../common/cursor';
import { Errors } from '../../common/errors';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';
import { loadOrder, requireOrders } from '../orders/orders.common';
import {
  lineProgress,
  requireFulfillment,
  returnDeadline,
  toReturns,
  valueOfUnits,
  type ReturnRow,
} from './fulfillment.common';

/** Returns (Phase 09, ADR-024): request within the window → approve/reject → receive (restock or write off). */
@Injectable()
export class ReturnsService {
  constructor(private readonly db: DbService) {}

  /** Shared by staff and the customer account: validates the window and the shipped, not-yet-returned quantities. */
  static async createReturn(
    tx: Tx,
    input: {
      tenantId: string;
      order: OrderRow;
      request: CreateReturnRequest;
      requestedBy: 'customer' | 'staff';
      userId: string | null;
      customerId: string | null;
      correlationId: string | null;
      now?: Date;
    },
  ): Promise<ReturnRow> {
    const { order, request } = input;
    const now = input.now ?? new Date();
    const ships = await tx.select().from(shipments).where(eq(shipments.orderId, order.id));
    const deadline = await returnDeadline(tx, input.tenantId, ships);
    if (!deadline)
      throw Errors.conflict('INVALID_STATE_TRANSITION', `Nothing on order ${order.number} has shipped yet`);
    if (now.getTime() > deadline.getTime())
      throw Errors.conflict(
        'RETURN_WINDOW_CLOSED',
        `The return window for order ${order.number} closed on ${deadline.toISOString().slice(0, 10)}`,
        {
          deadline: deadline.toISOString(),
        },
      );
    const lines = await tx
      .select()
      .from(orderLines)
      .where(eq(orderLines.orderId, order.id))
      .orderBy(asc(orderLines.lineNo));
    const progress = await lineProgress(tx, lines);
    const wanted = new Map<number, number>();
    for (const l of request.lines) wanted.set(l.lineNo, (wanted.get(l.lineNo) ?? 0) + l.quantity);
    const picked = [...wanted].map(([lineNo, quantity]) => {
      const line = lines.find((l) => l.lineNo === lineNo);
      if (!line) throw Errors.validation({ lineNo }, `Order ${order.number} has no line ${lineNo}`);
      const p = progress.get(line.id)!;
      const available = p.shipped - p.inReturn;
      if (quantity > available)
        throw Errors.unprocessable(
          'VALIDATION_FAILED',
          `Line ${lineNo} (${line.sku}): only ${available} shipped unit(s) can still be returned`,
          {
            lineNo,
            available,
          },
        );
      return { line, quantity, value: valueOfUnits(line.totalMinor, line.quantity, p.inReturn, quantity) };
    });
    const number = await nextDocumentNumber(tx, input.tenantId, 'return');
    const [row] = await tx
      .insert(returns)
      .values({
        tenantId: input.tenantId,
        number,
        orderId: order.id,
        customerId: input.customerId ?? order.customerId,
        reason: request.reason,
        requestedBy: input.requestedBy,
        createdBy: input.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await tx.insert(returnLines).values(
      picked.map((p) => ({
        tenantId: input.tenantId,
        returnId: row!.id,
        orderLineId: p.line.id,
        quantity: p.quantity,
        valueMinor: p.value,
      })),
    );
    await addOrderEvent(tx, {
      tenantId: input.tenantId,
      orderId: order.id,
      type: 'return_requested',
      actorUserId: input.userId,
      note: request.reason,
      data: { return: number, requestedBy: input.requestedBy },
      at: now,
    });
    await enqueueEvent(tx, {
      tenantId: input.tenantId,
      eventType: 'ReturnRequested',
      aggregateType: 'return',
      aggregateId: row!.id,
      correlationId: input.correlationId,
      payload: { returnId: row!.id, number, orderId: order.id },
    });
    await recordCustomerMessage(tx, {
      tenantId: input.tenantId,
      order,
      template: 'return_requested',
      detail: `Return ${number}: ${request.reason}`,
      now,
    });
    return row!;
  }

  private guard(ctx: TenantState) {
    requireOrders(ctx);
    requireFulfillment(ctx);
  }

  private async view(tx: Tx, rows: ReturnRow[]): Promise<OrderReturn[]> {
    const ids = [...new Set(rows.map((r) => r.orderId))];
    const os = ids.length ? await tx.select().from(orders).where(inArray(orders.id, ids)) : [];
    return toReturns(tx, rows, new Map(os.map((o) => [o.id, o])));
  }

  private audit(
    tx: Tx,
    auth: AuthState,
    ctx: TenantState,
    meta: RequestMeta,
    action: string,
    r: ReturnRow,
    values: Record<string, unknown>,
  ) {
    return writeAudit(tx, {
      tenantId: ctx.tenantId,
      actorType: 'user',
      actorUserId: auth.userId,
      action,
      entityType: 'return',
      entityId: r.id,
      oldValues: { status: r.status },
      newValues: values,
      correlationId: meta.correlationId,
      ip: meta.ip,
    });
  }

  async list(ctx: TenantState, q: ReturnListQuery): Promise<Page<OrderReturn>> {
    this.guard(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const where: (SQL | undefined)[] = [
        eq(returns.tenantId, ctx.tenantId),
        q.status ? eq(returns.status, q.status) : undefined,
      ];
      if (cursor) {
        const t = new Date(String(cursor.sortValue));
        where.push(or(lt(returns.createdAt, t), and(eq(returns.createdAt, t), lt(returns.id, cursor.id))));
      }
      const rows = await tx
        .select()
        .from(returns)
        .where(and(...where))
        .orderBy(desc(returns.createdAt), desc(returns.id))
        .limit(q.limit + 1);
      const page = paginate(rows, q.limit, (r) => r.createdAt.toISOString());
      return { items: await this.view(tx, page.items), nextCursor: page.nextCursor };
    });
  }

  async create(
    auth: AuthState,
    ctx: TenantState,
    orderId: string,
    input: CreateReturnRequest,
    meta: RequestMeta,
  ): Promise<OrderReturn> {
    this.guard(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const order = await loadOrder(tx, ctx.tenantId, orderId, true);
      const row = await ReturnsService.createReturn(tx, {
        tenantId: ctx.tenantId,
        order,
        request: input,
        requestedBy: 'staff',
        userId: auth.userId,
        customerId: null,
        correlationId: meta.correlationId,
      });
      await this.audit(tx, auth, ctx, meta, 'returns.created', row, {
        status: 'requested',
        number: row.number,
      });
      return (await this.view(tx, [row]))[0]!;
    });
  }

  private async lock(tx: Tx, ctx: TenantState, id: string, version: number) {
    const [r] = await tx.select().from(returns).where(eq(returns.id, id)).for('update');
    if (!r || r.tenantId !== ctx.tenantId) throw Errors.notFound('Return');
    if (r.version !== version) throw Errors.versionConflict(r.version);
    return r;
  }

  async decide(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: DecideReturnRequest,
    meta: RequestMeta,
  ): Promise<OrderReturn> {
    this.guard(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const r = await this.lock(tx, ctx, id, input.version);
      if (r.status !== 'requested')
        throw Errors.conflict('INVALID_STATE_TRANSITION', `Return ${r.number} is ${r.status}`);
      const now = new Date();
      const status = input.approve ? ('approved' as const) : ('rejected' as const);
      const [after] = await tx
        .update(returns)
        .set({
          status,
          decidedBy: auth.userId,
          decidedAt: now,
          decisionNote: input.note,
          version: r.version + 1,
          updatedAt: now,
        })
        .where(eq(returns.id, r.id))
        .returning();
      const order = await loadOrder(tx, ctx.tenantId, r.orderId);
      await addOrderEvent(tx, {
        tenantId: ctx.tenantId,
        orderId: order.id,
        type: input.approve ? 'return_approved' : 'return_rejected',
        actorUserId: auth.userId,
        note: input.note,
        data: { return: r.number },
        at: now,
      });
      await recordCustomerMessage(tx, {
        tenantId: ctx.tenantId,
        order,
        template: input.approve ? 'return_approved' : 'return_rejected',
        detail: input.note,
        now,
      });
      await this.audit(tx, auth, ctx, meta, input.approve ? 'returns.approved' : 'returns.rejected', r, {
        status,
        note: input.note,
      });
      return (await this.view(tx, [after!]))[0]!;
    });
  }

  async receive(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: ReceiveReturnRequest,
    meta: RequestMeta,
  ): Promise<OrderReturn> {
    this.guard(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const r = await this.lock(tx, ctx, id, input.version);
      if (r.status !== 'approved')
        throw Errors.conflict(
          'INVALID_STATE_TRANSITION',
          `Return ${r.number} is ${r.status}; approve it first`,
        );
      const [loc] = await tx
        .select()
        .from(locations)
        .where(and(eq(locations.id, input.locationId), eq(locations.tenantId, ctx.tenantId)));
      if (!loc) throw Errors.notFound('Location');
      if (loc.status !== 'active')
        throw Errors.unprocessable('VALIDATION_FAILED', `${loc.name} is not active`);
      const rl = await tx
        .select({
          qty: returnLines.quantity,
          variantId: orderLines.variantId,
          serialItemId: orderLines.serialItemId,
        })
        .from(returnLines)
        .innerJoin(orderLines, eq(orderLines.id, returnLines.orderLineId))
        .where(eq(returnLines.returnId, r.id));
      const now = new Date();
      await receiveReturnStock(tx, {
        tenantId: ctx.tenantId,
        reference: r.number,
        actorUserId: auth.userId,
        correlationId: meta.correlationId,
        restock: input.restock,
        locationId: loc.id,
        items: rl.map((l) => ({
          variantId: l.variantId,
          serialItemId: l.serialItemId,
          quantity: String(l.qty),
        })),
      });
      const [after] = await tx
        .update(returns)
        .set({
          status: 'received',
          receivedBy: auth.userId,
          receivedAt: now,
          restocked: input.restock,
          receiveLocationId: loc.id,
          version: r.version + 1,
          updatedAt: now,
        })
        .where(eq(returns.id, r.id))
        .returning();
      const order = await loadOrder(tx, ctx.tenantId, r.orderId);
      await addOrderEvent(tx, {
        tenantId: ctx.tenantId,
        orderId: order.id,
        type: 'return_received',
        actorUserId: auth.userId,
        note: input.restock ? `Restocked at ${loc.name}` : 'Received; not restocked (written off)',
        data: { return: r.number, restocked: input.restock },
        at: now,
      });
      await enqueueEvent(tx, {
        tenantId: ctx.tenantId,
        eventType: 'ReturnReceived',
        aggregateType: 'return',
        aggregateId: r.id,
        correlationId: meta.correlationId,
        payload: { returnId: r.id, number: r.number, orderId: order.id, restocked: input.restock },
      });
      await recordCustomerMessage(tx, { tenantId: ctx.tenantId, order, template: 'return_received', now });
      await this.audit(tx, auth, ctx, meta, 'returns.received', r, {
        status: 'received',
        restocked: input.restock,
        location: loc.name,
      });
      return (await this.view(tx, [after!]))[0]!;
    });
  }
}
