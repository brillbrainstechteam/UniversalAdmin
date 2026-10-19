import { Injectable } from '@nestjs/common';
import type {
  DeclineRfqRequest,
  QuoteLineInput,
  QuoteRfqRequest,
  Rfq,
  RfqListQuery,
  RfqMessageRequest,
} from '@uc/contracts';
import {
  companies,
  companyBuyers,
  enqueueEvent,
  nextDocumentNumber,
  products,
  quotations,
  rfqMessages,
  rfqs,
  serialItems,
  users,
  variants,
  writeAudit,
  type Tx,
} from '@uc/db';
import { and, asc, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { decodeCursor, paginate } from '../../common/cursor';
import { AppError, Errors } from '../../common/errors';
import { iso } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';
import { loadOrderSettings } from '../orders/orders.common';
import { QuoteService } from '../pricing/quote.service';
import { repFilter, requireB2b } from './b2b.common';

type RfqRow = typeof rfqs.$inferSelect;

export async function toRfq(tx: Tx, r: RfqRow): Promise<Rfq> {
  const [[company], [buyer], messages] = await Promise.all([
    tx
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(eq(companies.id, r.companyId)),
    tx
      .select({ id: companyBuyers.id, email: companyBuyers.email, name: users.displayName })
      .from(companyBuyers)
      .leftJoin(users, eq(users.id, companyBuyers.userId))
      .where(eq(companyBuyers.id, r.buyerId)),
    tx
      .select({ m: rfqMessages, name: users.displayName })
      .from(rfqMessages)
      .leftJoin(users, eq(users.id, rfqMessages.authorUserId))
      .where(eq(rfqMessages.rfqId, r.id))
      .orderBy(asc(rfqMessages.createdAt), asc(rfqMessages.id)),
  ]);
  const lines = r.lines as {
    variantId: string;
    serialItemId?: string;
    quantity: number;
    note?: string | null;
  }[];
  const vs = lines.length
    ? await tx
        .select({ id: variants.id, sku: variants.sku, vt: variants.title, title: products.title })
        .from(variants)
        .innerJoin(products, eq(products.id, variants.productId))
        .where(
          inArray(
            variants.id,
            lines.map((l) => l.variantId),
          ),
        )
    : [];
  const pieceIds = lines.map((l) => l.serialItemId).filter((x): x is string => !!x);
  const pieces = pieceIds.length
    ? await tx
        .select({ id: serialItems.id, tag: serialItems.serialTag })
        .from(serialItems)
        .where(inArray(serialItems.id, pieceIds))
    : [];
  const items = lines.map((l) => {
    const v = vs.find((x) => x.id === l.variantId);
    return {
      sku: v?.sku ?? '?',
      title: v ? (v.vt ? `${v.title} — ${v.vt}` : v.title) : 'Unknown item',
      serialTag: pieces.find((p) => p.id === l.serialItemId)?.tag ?? null,
      quantity: l.quantity,
      note: l.note ?? null,
    };
  });
  return {
    id: r.id,
    number: r.number,
    items,
    status:
      r.status === 'submitted' && r.neededBy && r.neededBy.getTime() <= Date.now() ? 'expired' : r.status,
    company: company!,
    buyer: { id: buyer!.id, name: buyer!.name ?? buyer!.email, email: buyer!.email },
    locationId: r.locationId,
    lines: r.lines as Rfq['lines'],
    note: r.note,
    neededBy: r.neededBy ? iso(r.neededBy) : null,
    quotationId: r.quotationId,
    messages: messages.map(({ m, name }) => ({
      id: m.id,
      author: m.author,
      authorName: name ?? (m.author === 'staff' ? 'Staff' : 'Buyer'),
      body: m.body,
      createdAt: iso(m.createdAt),
    })),
    createdAt: iso(r.createdAt),
    version: r.version,
  };
}

/** Staff side of RFQ negotiation: inbox, messages, quote (creates and sends a frozen quotation), decline. */
@Injectable()
export class RfqsService {
  constructor(
    private readonly db: DbService,
    private readonly quotes: QuoteService,
  ) {}

  private async load(tx: Tx, auth: AuthState, ctx: TenantState, id: string, lock = false) {
    const q = tx
      .select({ r: rfqs, rep: companies.salesRepUserId })
      .from(rfqs)
      .innerJoin(companies, eq(companies.id, rfqs.companyId))
      .where(and(eq(rfqs.tenantId, ctx.tenantId), eq(rfqs.id, id)));
    const [row] = lock ? await q.for('update', { of: rfqs }) : await q;
    const rep = repFilter(ctx, auth.userId);
    if (!row || (rep && row.rep !== rep)) throw Errors.notFound('RFQ');
    return row.r;
  }

  async list(auth: AuthState, ctx: TenantState, q: RfqListQuery) {
    requireB2b(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const rep = repFilter(ctx, auth.userId);
      const where: (SQL | undefined)[] = [
        eq(rfqs.tenantId, ctx.tenantId),
        q.status ? eq(rfqs.status, q.status) : undefined,
        q.companyId ? eq(rfqs.companyId, q.companyId) : undefined,
        rep ? eq(companies.salesRepUserId, rep) : undefined,
      ];
      if (cursor) {
        const at = new Date(String(cursor.sortValue));
        where.push(or(lt(rfqs.createdAt, at), and(eq(rfqs.createdAt, at), lt(rfqs.id, cursor.id))));
      }
      const rows = await tx
        .select({ r: rfqs, company: companies.name, buyer: users.displayName, email: companyBuyers.email })
        .from(rfqs)
        .innerJoin(companies, eq(companies.id, rfqs.companyId))
        .innerJoin(companyBuyers, eq(companyBuyers.id, rfqs.buyerId))
        .leftJoin(users, eq(users.id, companyBuyers.userId))
        .where(and(...where))
        .orderBy(desc(rfqs.createdAt), desc(rfqs.id))
        .limit(q.limit + 1);
      return paginate(
        rows.map(({ r, company, buyer, email }) => ({
          id: r.id,
          number: r.number,
          status: r.status,
          company: { id: r.companyId, name: company },
          quotationId: r.quotationId,
          createdAt: iso(r.createdAt),
          lineCount: (r.lines as unknown[]).length,
          buyerName: buyer ?? email,
        })),
        q.limit,
        (r) => r.createdAt,
      );
    });
  }

  async get(auth: AuthState, ctx: TenantState, id: string): Promise<Rfq> {
    requireB2b(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => toRfq(tx, await this.load(tx, auth, ctx, id)));
  }

  async message(auth: AuthState, ctx: TenantState, id: string, input: RfqMessageRequest): Promise<Rfq> {
    requireB2b(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const r = await this.load(tx, auth, ctx, id);
      if (!['submitted', 'quoted'].includes(r.status))
        throw new AppError(409, 'INVALID_STATE_TRANSITION', `RFQ ${r.number} is ${r.status}`);
      await tx.insert(rfqMessages).values({
        tenantId: ctx.tenantId,
        rfqId: r.id,
        author: 'staff',
        authorUserId: auth.userId,
        body: input.body,
      });
      return toRfq(tx, r);
    });
  }

  /** Prices the (possibly revised) lines with the company's book and sends a quotation frozen until validUntil. */
  async quote(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: QuoteRfqRequest,
    meta: RequestMeta,
  ): Promise<Rfq> {
    requireB2b(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const r = await this.load(tx, auth, ctx, id, true);
      if (r.version !== input.version) throw Errors.versionConflict(r.version);
      if (r.status !== 'submitted')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', `RFQ ${r.number} is ${r.status}`);
      const settings = await loadOrderSettings(tx, ctx.tenantId);
      const until = new Date(input.validUntil);
      if (
        until.getTime() <= Date.now() ||
        until.getTime() > Date.now() + settings.quotationMaxDays * 24 * 3600_000
      )
        throw Errors.validation([
          {
            path: 'validUntil',
            message: `Must be in the future and at most ${settings.quotationMaxDays} days ahead`,
          },
        ]);
      const [company] = await tx.select().from(companies).where(eq(companies.id, r.companyId));
      const [buyer] = await tx
        .select({ email: companyBuyers.email, name: users.displayName })
        .from(companyBuyers)
        .leftJoin(users, eq(users.id, companyBuyers.userId))
        .where(eq(companyBuyers.id, r.buyerId));
      const lines: QuoteLineInput[] =
        input.lines ??
        (r.lines as QuoteLineInput[]).map(({ variantId, serialItemId, quantity }) => ({
          variantId,
          ...(serialItemId ? { serialItemId } : {}),
          quantity,
        }));
      const [b2bChannel] = await tx
        .execute<{ id: string }>(
          sql`select id from channels where tenant_id = ${ctx.tenantId} and type = 'b2b_storefront' and status = 'active' order by created_at limit 1`,
        )
        .then((x) => x.rows);
      const scope = await this.quotes.scope(tx, ctx, b2bChannel?.id ?? null, false, company!.priceBookId);
      const priced = await this.quotes.priceLines(tx, scope, lines);
      const pq = await this.quotes.insertQuote(tx, scope, lines, priced, 'admin', auth.userId, until);
      const now = new Date();
      const [quotation] = await tx
        .insert(quotations)
        .values({
          tenantId: ctx.tenantId,
          number: await nextDocumentNumber(tx, ctx.tenantId, 'quotation'),
          status: 'sent',
          channelId: b2bChannel?.id ?? null,
          contact: { name: `${buyer!.name ?? buyer!.email} (${company!.name})`, email: buyer!.email },
          notes: input.notes,
          lines,
          validUntil: until,
          priceQuoteId: pq.id,
          companyId: company!.id,
          rfqId: r.id,
          createdBy: auth.userId,
          sentAt: now,
        })
        .returning();
      await tx
        .update(rfqs)
        .set({ status: 'quoted', quotationId: quotation!.id, version: r.version + 1, updatedAt: now })
        .where(eq(rfqs.id, r.id));
      await tx.insert(rfqMessages).values({
        tenantId: ctx.tenantId,
        rfqId: r.id,
        author: 'staff',
        authorUserId: auth.userId,
        body: `Quotation ${quotation!.number} sent: valid until ${iso(until)}.${input.notes ? ` ${input.notes}` : ''}`,
      });
      await enqueueEvent(tx, {
        tenantId: ctx.tenantId,
        eventType: 'QuoteSent',
        aggregateType: 'quotation',
        aggregateId: quotation!.id,
        correlationId: meta.correlationId,
        payload: { quotationId: quotation!.id, rfqId: r.id, totalMinor: pq.totalMinor.toString() },
      });
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: 'rfq.quoted',
        entityType: 'rfq',
        entityId: r.id,
        newValues: { quotation: quotation!.number, totalMinor: pq.totalMinor.toString() },
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      const [after] = await tx.select().from(rfqs).where(eq(rfqs.id, r.id));
      return toRfq(tx, after!);
    });
  }

  async decline(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: DeclineRfqRequest,
    meta: RequestMeta,
  ): Promise<Rfq> {
    requireB2b(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const r = await this.load(tx, auth, ctx, id, true);
      if (r.version !== input.version) throw Errors.versionConflict(r.version);
      if (r.status !== 'submitted')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', `RFQ ${r.number} is ${r.status}`);
      const [after] = await tx
        .update(rfqs)
        .set({
          status: 'declined',
          declineReason: input.reason,
          version: r.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(rfqs.id, r.id))
        .returning();
      await tx.insert(rfqMessages).values({
        tenantId: ctx.tenantId,
        rfqId: r.id,
        author: 'staff',
        authorUserId: auth.userId,
        body: `Declined: ${input.reason}`,
      });
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: 'rfq.declined',
        entityType: 'rfq',
        entityId: r.id,
        reason: input.reason,
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return toRfq(tx, after!);
    });
  }
}
