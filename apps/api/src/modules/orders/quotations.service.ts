import { Injectable } from '@nestjs/common';
import type {
  AcceptQuotationRequest,
  CancelQuotationRequest,
  Contact,
  ConvertQuotationRequest,
  CreateQuotationRequest,
  Order,
  Page,
  Quotation,
  QuotationActionRequest,
  QuotationListQuery,
  QuoteLine,
  QuoteLineInput,
  UpdateQuotationRequest,
} from '@uc/contracts';
import {
  channels,
  enqueueEvent,
  nextDocumentNumber,
  priceQuotes,
  quotations,
  users,
  writeAudit,
  type Tx,
} from '@uc/db';
import { and, desc, eq, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import { decodeCursor, paginate } from '../../common/cursor';
import { AppError, Errors } from '../../common/errors';
import { iso, likePattern } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';
import { QuoteService } from '../pricing/quote.service';
import { loadOrderSettings, placeOrder, requireOrders, toOrder } from './orders.common';
import { APPROVAL_HOLD_MINUTES } from './orders.service';

type Row = typeof quotations.$inferSelect;

/**
 * Sales quotations (ADR-022): draft → sent (price frozen as a price quote valid until the chosen date) → accepted →
 * converted into an order AT THE FROZEN PRICE (an accepted quote keeps its terms until expiry) | cancelled | expired.
 */
@Injectable()
export class QuotationsService {
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
    values: Record<string, unknown>,
    reason?: string | null,
  ) {
    return writeAudit(tx, {
      tenantId: ctx.tenantId,
      actorType: 'user',
      actorUserId: auth.userId,
      action,
      entityType: 'quotation',
      entityId: id,
      newValues: values,
      reason: reason ?? null,
      correlationId: meta.correlationId,
      ip: meta.ip,
    });
  }

  private async load(tx: Tx, ctx: TenantState, id: string, lock = false): Promise<Row> {
    const q = tx
      .select()
      .from(quotations)
      .where(and(eq(quotations.tenantId, ctx.tenantId), eq(quotations.id, id)));
    const [row] = lock ? await q.for('update') : await q;
    if (!row) throw Errors.notFound('Quotation');
    return row;
  }

  private async toQuotation(tx: Tx, r: Row): Promise<Quotation> {
    const [chan] = r.channelId
      ? await tx
          .select({ id: channels.id, name: channels.name })
          .from(channels)
          .where(eq(channels.id, r.channelId))
      : [];
    const [creator] = r.createdBy
      ? await tx
          .select({ id: users.id, name: users.displayName })
          .from(users)
          .where(eq(users.id, r.createdBy))
      : [];
    const [pq] = r.priceQuoteId
      ? await tx.select().from(priceQuotes).where(eq(priceQuotes.id, r.priceQuoteId))
      : [];
    return {
      id: r.id,
      number: r.number,
      status: r.status,
      channel: chan ?? null,
      contact: r.contact as Contact,
      notes: r.notes,
      lines: r.lines as QuoteLineInput[],
      validUntil: iso(r.validUntil),
      priceQuote: pq ? await this.quotes.toQuote(tx, pq) : null,
      currency: pq?.currency ?? null,
      totalMinor: pq ? pq.totalMinor.toString() : null,
      acceptanceNote: r.acceptanceNote,
      orderId: r.orderId,
      createdBy: creator ?? null,
      sentAt: r.sentAt ? iso(r.sentAt) : null,
      acceptedAt: r.acceptedAt ? iso(r.acceptedAt) : null,
      cancelReason: r.cancelReason,
      version: r.version,
      createdAt: iso(r.createdAt),
    };
  }

  private async checkValidity(tx: Tx, tenantId: string, validUntil: string) {
    const settings = await loadOrderSettings(tx, tenantId);
    const until = new Date(validUntil).getTime();
    if (until <= Date.now())
      throw Errors.validation([{ path: 'validUntil', message: 'Must be in the future' }]);
    if (until > Date.now() + settings.quotationMaxDays * 24 * 3600_000)
      throw Errors.validation([
        { path: 'validUntil', message: `At most ${settings.quotationMaxDays} days ahead (order settings)` },
      ]);
  }

  private async checkChannel(tx: Tx, tenantId: string, channelId: string | null) {
    if (!channelId) return;
    const [c] = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.tenantId, tenantId), eq(channels.id, channelId)));
    if (!c) throw Errors.validation([{ path: 'channelId', message: 'Unknown channel' }]);
  }

  async list(
    ctx: TenantState,
    q: QuotationListQuery,
  ): Promise<Page<ReturnType<QuotationsService['summary']>>> {
    requireOrders(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const where: (SQL | undefined)[] = [
        eq(quotations.tenantId, ctx.tenantId),
        q.status ? eq(quotations.status, q.status) : undefined,
      ];
      if (q.q)
        where.push(
          or(
            ilike(quotations.number, likePattern(q.q)),
            sql`${quotations.contact}->>'name' ilike ${likePattern(q.q)}`,
          ),
        );
      if (cursor) {
        const at = new Date(String(cursor.sortValue));
        where.push(
          or(lt(quotations.createdAt, at), and(eq(quotations.createdAt, at), lt(quotations.id, cursor.id))),
        );
      }
      const rows = await tx
        .select({
          r: quotations,
          channelName: channels.name,
          total: priceQuotes.totalMinor,
          currency: priceQuotes.currency,
        })
        .from(quotations)
        .leftJoin(channels, eq(channels.id, quotations.channelId))
        .leftJoin(priceQuotes, eq(priceQuotes.id, quotations.priceQuoteId))
        .where(and(...where))
        .orderBy(desc(quotations.createdAt), desc(quotations.id))
        .limit(q.limit + 1);
      return paginate(
        rows.map((x) => this.summary(x.r, x.channelName, x.total, x.currency)),
        q.limit,
        (r) => r.createdAt,
      );
    });
  }

  private summary(r: Row, channelName: string | null, total: bigint | null, currency: string | null) {
    return {
      id: r.id,
      number: r.number,
      status: r.status,
      channel: r.channelId ? { id: r.channelId, name: channelName ?? '' } : null,
      validUntil: iso(r.validUntil),
      currency,
      totalMinor: total === null ? null : total.toString(),
      createdAt: iso(r.createdAt),
      contactName: (r.contact as Contact).name,
    };
  }

  async get(ctx: TenantState, id: string): Promise<Quotation> {
    requireOrders(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => this.toQuotation(tx, await this.load(tx, ctx, id)));
  }

  async create(
    auth: AuthState,
    ctx: TenantState,
    input: CreateQuotationRequest,
    meta: RequestMeta,
  ): Promise<Quotation> {
    requireOrders(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await this.checkChannel(tx, ctx.tenantId, input.channelId);
      await this.checkValidity(tx, ctx.tenantId, input.validUntil);
      // Validate the lines by pricing them now (nothing is frozen until the quotation is sent).
      const scope = await this.quotes.scope(tx, ctx, input.channelId, false);
      await this.quotes.priceLines(tx, scope, input.lines);
      const [row] = await tx
        .insert(quotations)
        .values({
          tenantId: ctx.tenantId,
          number: await nextDocumentNumber(tx, ctx.tenantId, 'quotation'),
          channelId: input.channelId,
          contact: input.contact,
          notes: input.notes,
          lines: input.lines,
          validUntil: new Date(input.validUntil),
          createdBy: auth.userId,
        })
        .returning();
      await this.audit(tx, auth, ctx, meta, 'quotation.created', row!.id, {
        number: row!.number,
        lines: input.lines.length,
      });
      return this.toQuotation(tx, row!);
    });
  }

  async update(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: UpdateQuotationRequest,
    meta: RequestMeta,
  ): Promise<Quotation> {
    requireOrders(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const row = await this.load(tx, ctx, id, true);
      if (row.version !== input.version) throw Errors.versionConflict(row.version);
      if (row.status !== 'draft')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', 'Only a draft quotation can be edited');
      if (input.validUntil) await this.checkValidity(tx, ctx.tenantId, input.validUntil);
      if (input.lines) {
        const scope = await this.quotes.scope(tx, ctx, row.channelId, false);
        await this.quotes.priceLines(tx, scope, input.lines);
      }
      const [after] = await tx
        .update(quotations)
        .set({
          ...(input.contact ? { contact: input.contact } : {}),
          ...(input.lines ? { lines: input.lines } : {}),
          ...(input.validUntil ? { validUntil: new Date(input.validUntil) } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(quotations.id, row.id))
        .returning();
      await this.audit(tx, auth, ctx, meta, 'quotation.updated', row.id, {
        fields: Object.keys(input).filter((k) => k !== 'version'),
      });
      return this.toQuotation(tx, after!);
    });
  }

  /** Freezes the price: a price quote valid until the quotation's validity date. */
  async send(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: QuotationActionRequest,
    meta: RequestMeta,
  ) {
    requireOrders(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const row = await this.load(tx, ctx, id, true);
      if (row.version !== input.version) throw Errors.versionConflict(row.version);
      if (row.status !== 'draft')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', `Quotation ${row.number} is ${row.status}`);
      await this.checkValidity(tx, ctx.tenantId, iso(row.validUntil));
      const lines = row.lines as QuoteLineInput[];
      const scope = await this.quotes.scope(tx, ctx, row.channelId, false);
      const priced = await this.quotes.priceLines(tx, scope, lines);
      const pq = await this.quotes.insertQuote(
        tx,
        scope,
        lines,
        priced,
        'admin',
        auth.userId,
        row.validUntil,
      );
      const now = new Date();
      const [after] = await tx
        .update(quotations)
        .set({ status: 'sent', priceQuoteId: pq.id, sentAt: now, version: row.version + 1, updatedAt: now })
        .where(eq(quotations.id, row.id))
        .returning();
      await enqueueEvent(tx, {
        tenantId: ctx.tenantId,
        eventType: 'QuoteSent',
        aggregateType: 'quotation',
        aggregateId: row.id,
        correlationId: meta.correlationId,
        payload: {
          quotationId: row.id,
          number: row.number,
          totalMinor: pq.totalMinor.toString(),
          currency: pq.currency,
          validUntil: iso(row.validUntil),
        },
      });
      await this.audit(tx, auth, ctx, meta, 'quotation.sent', row.id, {
        totalMinor: pq.totalMinor.toString(),
        validUntil: iso(row.validUntil),
      });
      return this.toQuotation(tx, after!);
    });
  }

  private assertLive(row: Row) {
    if (row.validUntil.getTime() <= Date.now())
      throw new AppError(409, 'QUOTE_EXPIRED', `Quotation ${row.number} expired on ${iso(row.validUntil)}`);
  }

  async accept(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: AcceptQuotationRequest,
    meta: RequestMeta,
  ) {
    requireOrders(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const row = await this.load(tx, ctx, id, true);
      if (row.version !== input.version) throw Errors.versionConflict(row.version);
      if (row.status !== 'sent')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', `Quotation ${row.number} is ${row.status}`);
      this.assertLive(row);
      const now = new Date();
      const [after] = await tx
        .update(quotations)
        .set({
          status: 'accepted',
          acceptedAt: now,
          acceptanceNote: input.note,
          version: row.version + 1,
          updatedAt: now,
        })
        .where(eq(quotations.id, row.id))
        .returning();
      await enqueueEvent(tx, {
        tenantId: ctx.tenantId,
        eventType: 'QuoteAccepted',
        aggregateType: 'quotation',
        aggregateId: row.id,
        correlationId: meta.correlationId,
        payload: { quotationId: row.id, number: row.number },
      });
      await this.audit(
        tx,
        auth,
        ctx,
        meta,
        'quotation.accepted',
        row.id,
        { acceptedAt: iso(now) },
        input.note,
      );
      return this.toQuotation(tx, after!);
    });
  }

  /** Creates the order at the frozen price (no re-pricing), holding stock now; approval rules still apply. */
  async convert(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: ConvertQuotationRequest,
    meta: RequestMeta,
  ): Promise<Order> {
    requireOrders(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const row = await this.load(tx, ctx, id, true);
      if (row.version !== input.version) throw Errors.versionConflict(row.version);
      if (row.status !== 'accepted')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', `Quotation ${row.number} is ${row.status}`);
      this.assertLive(row);
      const [pq] = await tx.select().from(priceQuotes).where(eq(priceQuotes.id, row.priceQuoteId!));
      const settings = await loadOrderSettings(tx, ctx.tenantId);
      const needsApproval =
        settings.approvalThresholdMinor !== null && pq!.totalMinor >= settings.approvalThresholdMinor;
      const order = await placeOrder(tx, {
        tenantId: ctx.tenantId,
        channelId: row.channelId,
        origin: 'quotation',
        paymentTerms: 'on_account',
        contact: row.contact as Contact,
        shippingAddress: input.shippingAddress,
        note: `From quotation ${row.number}`,
        priced: pq!.lines as QuoteLine[],
        currency: pq!.currency,
        subtotalMinor: pq!.subtotalMinor,
        discountMinor: pq!.discountMinor,
        taxMinor: pq!.taxMinor,
        totalMinor: pq!.totalMinor,
        priceQuoteId: pq!.id,
        quotationId: row.id,
        next: needsApproval ? 'awaiting_approval' : 'confirm',
        holdMinutes: needsApproval ? APPROVAL_HOLD_MINUTES : settings.checkoutHoldMinutes,
        actorUserId: auth.userId,
        correlationId: meta.correlationId,
        now: new Date(),
      });
      await tx
        .update(quotations)
        .set({ status: 'converted', orderId: order.id, version: row.version + 1, updatedAt: new Date() })
        .where(eq(quotations.id, row.id));
      await this.audit(tx, auth, ctx, meta, 'quotation.converted', row.id, {
        orderId: order.id,
        orderNumber: order.number,
      });
      return toOrder(tx, order);
    });
  }

  async cancel(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: CancelQuotationRequest,
    meta: RequestMeta,
  ) {
    requireOrders(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const row = await this.load(tx, ctx, id, true);
      if (row.version !== input.version) throw Errors.versionConflict(row.version);
      if (!['draft', 'sent', 'accepted'].includes(row.status))
        throw new AppError(409, 'INVALID_STATE_TRANSITION', `Quotation ${row.number} is ${row.status}`);
      const [after] = await tx
        .update(quotations)
        .set({
          status: 'cancelled',
          cancelReason: input.reason,
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(quotations.id, row.id))
        .returning();
      await this.audit(
        tx,
        auth,
        ctx,
        meta,
        'quotation.cancelled',
        row.id,
        { status: 'cancelled' },
        input.reason,
      );
      return this.toQuotation(tx, after!);
    });
  }
}
