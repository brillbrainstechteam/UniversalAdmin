import { Injectable } from '@nestjs/common';
import type {
  AcceptBuyerInvitationRequest,
  BuyerAcceptQuotationRequest,
  BuyerCatalogQuery,
  BuyerContext,
  BuyerDecisionRequest,
  BuyerOrder,
  BuyerOrderListQuery,
  BuyerPlaceOrderRequest,
  BuyerPriceRequest,
  BuyerPriceResponse,
  BuyerQuotation,
  BuyerRfqRequest,
  FeatureKey,
  OrderSummary,
  Page,
  QuoteLine,
  QuoteLineInput,
  Rfq,
  RfqMessageRequest,
} from '@uc/contracts';
import { PASSWORD_MIN } from '@uc/contracts';
import {
  addOrderEvent,
  cancelOrder,
  channelPublications,
  collectionProducts,
  companies,
  companyBuyers,
  companyLocations,
  confirmOrder,
  enqueueEvent,
  hashPassword,
  nextDocumentNumber,
  orderLines,
  orders,
  priceListEntries,
  priceQuotes,
  products,
  quotations,
  rfqMessages,
  rfqs,
  serialItems,
  sha256,
  users,
  variants,
  verifyPassword,
  writeAudit,
  type OrderRow,
  type Tx,
} from '@uc/db';
import { and, asc, desc, eq, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { decodeCursor, paginate } from '../../common/cursor';
import { AppError, Errors } from '../../common/errors';
import { iso, likePattern } from '../../common/mappers';
import type { AppRequest, RequestMeta } from '../../common/request';
import { DbService } from '../../db/db.service';
import { loadFeatures } from '../access/access.service';
import { AuthService } from '../auth/auth.service';
import { SessionService } from '../auth/session.service';
import { loadOrderSettings, placeOrder, toSummary } from '../orders/orders.common';
import { APPROVAL_HOLD_MINUTES } from '../orders/orders.service';
import { QuoteService } from '../pricing/quote.service';
import { StorefrontResolver } from '../storefront/storefront.controller';
import {
  chargeCredit,
  creditSummary,
  guardCompanyOrder,
  toLocation,
  type BuyerRow,
  type CompanyRow,
} from './b2b.common';
import { toRfq } from './rfqs.service';

export interface Portal {
  tenantId: string;
  channelId: string;
  features: FeatureKey[];
  storefrontName: string;
  currency: string;
  isDemo: boolean;
}
export interface BuyerScope extends Portal {
  userId: string;
  sessionExpiresAt: Date;
  buyer: BuyerRow;
  company: CompanyRow;
  memberships: { buyer: BuyerRow; company: CompanyRow }[];
}

type Problem = { line: number; code: string; message: string };

/**
 * Buyer portal (ADR-023). Tenant and channel come from the B2B storefront domain; identity from a `buyer` session;
 * the company from the buyer's own memberships (optionally chosen with X-Company-Id). Every query is filtered by
 * that company (and the buyer's location scope) — never by IDs supplied in the request alone.
 */
@Injectable()
export class BuyerService {
  constructor(
    private readonly db: DbService,
    private readonly resolver: StorefrontResolver,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly quotes: QuoteService,
  ) {}

  // ---------------------------------------------------------------- scope

  async portal(req: AppRequest): Promise<Portal> {
    const { tenantId, channelId, preset, config } = await this.resolver.resolveContext(
      this.resolver.hostOf(req),
    );
    if (config.channel.type !== 'b2b_storefront')
      throw new AppError(404, 'STOREFRONT_NOT_FOUND', 'No buyer portal on this domain');
    const features = await this.db.tenant(tenantId, (tx) => loadFeatures(tx, tenantId, preset));
    if (!features.includes('b2b_companies'))
      throw new AppError(404, 'STOREFRONT_NOT_FOUND', 'No buyer portal on this domain');
    return {
      tenantId,
      channelId,
      features,
      storefrontName: config.channel.name,
      currency: config.currency,
      isDemo: config.tenant.isDemo,
    };
  }

  private async memberships(tx: Tx, tenantId: string, userId: string) {
    const rows = await tx
      .select({ buyer: companyBuyers, company: companies })
      .from(companyBuyers)
      .innerJoin(companies, eq(companies.id, companyBuyers.companyId))
      .where(
        and(
          eq(companyBuyers.tenantId, tenantId),
          eq(companyBuyers.userId, userId),
          eq(companyBuyers.status, 'active'),
        ),
      )
      .orderBy(asc(companies.name));
    return rows.filter((r) => r.company.status !== 'inactive');
  }

  async scope(req: AppRequest): Promise<BuyerScope> {
    const portal = await this.portal(req);
    const auth = await this.sessions.resolve(this.sessions.tokenFrom(req, 'buyer'), 'buyer');
    if (!auth) throw Errors.unauthenticated('Please sign in to the buyer portal');
    const list = await this.db.tenant(portal.tenantId, (tx) =>
      this.memberships(tx, portal.tenantId, auth.userId),
    );
    if (!list.length) throw new AppError(403, 'FORBIDDEN', 'You are not a buyer of this merchant');
    const wanted = req.header('x-company-id');
    const chosen = wanted ? list.find((m) => m.company.id === wanted) : list[0];
    if (!chosen) throw Errors.notFound('Company');
    return {
      ...portal,
      userId: auth.userId,
      sessionExpiresAt: auth.sessionExpiresAt,
      buyer: chosen.buyer,
      company: chosen.company,
      memberships: list,
    };
  }

  private canSeeLocation(s: BuyerScope, locationId: string | null) {
    return !s.buyer.locationIds || (locationId !== null && s.buyer.locationIds.includes(locationId));
  }

  // ---------------------------------------------------------------- auth

  async login(req: AppRequest, email: string, password: string, meta: RequestMeta) {
    const portal = await this.portal(req);
    const user = await this.auth.authenticate(
      { email, password, audience: 'buyer' },
      meta,
      async (userId) => {
        const list = await this.db.tenant(portal.tenantId, (tx) =>
          this.memberships(tx, portal.tenantId, userId),
        );
        if (!list.length)
          throw new AppError(403, 'FORBIDDEN', 'This account has no buyer access on this portal');
      },
    );
    const session = await this.sessions.create(user.id, 'buyer', meta);
    return { token: session.token };
  }

  async logout(req: AppRequest) {
    const auth = await this.sessions.resolve(this.sessions.tokenFrom(req, 'buyer'), 'buyer');
    if (auth) await this.sessions.revoke(auth.sessionId);
  }

  async context(s: BuyerScope): Promise<BuyerContext> {
    return this.db.tenant(s.tenantId, async (tx) => {
      const [u] = await tx.select().from(users).where(eq(users.id, s.userId));
      const locs = await tx
        .select()
        .from(companyLocations)
        .where(and(eq(companyLocations.companyId, s.company.id), eq(companyLocations.status, 'active')))
        .orderBy(asc(companyLocations.name));
      return {
        user: { id: u!.id, email: u!.email, displayName: u!.displayName },
        storefront: { name: s.storefrontName, currency: s.currency, isDemo: s.isDemo },
        companies: s.memberships.map((m) => ({ id: m.company.id, name: m.company.name, role: m.buyer.role })),
        company: {
          id: s.company.id,
          name: s.company.name,
          role: s.buyer.role,
          status: s.company.status,
          paymentTerms: s.company.paymentTerms,
          minOrderMinor: s.company.minOrderMinor?.toString() ?? null,
          orderLimitMinor: s.buyer.orderLimitMinor?.toString() ?? null,
          locations: locs
            .filter((l) => this.canSeeLocation(s, l.id))
            .map((l) => {
              const { id, name, code, address } = toLocation(l);
              return { id, name, code, address };
            }),
          credit: await creditSummary(tx, s.company),
        },
        sessionExpiresAt: iso(s.sessionExpiresAt),
      };
    });
  }

  private async invitation(tx: Tx, tenantId: string, token: string) {
    const [row] = await tx
      .select({ buyer: companyBuyers, company: companies })
      .from(companyBuyers)
      .innerJoin(companies, eq(companies.id, companyBuyers.companyId))
      .where(and(eq(companyBuyers.tenantId, tenantId), eq(companyBuyers.invitationTokenHash, sha256(token))));
    if (
      !row ||
      row.buyer.status !== 'invited' ||
      !row.buyer.invitationExpiresAt ||
      row.buyer.invitationExpiresAt.getTime() <= Date.now()
    )
      throw new AppError(400, 'INVITATION_INVALID', 'This invitation is invalid or has expired');
    return row;
  }

  async previewInvitation(req: AppRequest, token: string) {
    const portal = await this.portal(req);
    return this.db.tenant(portal.tenantId, async (tx) => {
      const { buyer, company } = await this.invitation(tx, portal.tenantId, token);
      const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.email, buyer.email));
      return {
        email: buyer.email,
        companyName: company.name,
        storefrontName: portal.storefrontName,
        role: buyer.role,
        userExists: Boolean(u),
        expiresAt: iso(buyer.invitationExpiresAt!),
      };
    });
  }

  /** Single use: a new user sets a password; an existing user proves the current one. */
  async acceptInvitation(req: AppRequest, input: AcceptBuyerInvitationRequest, meta: RequestMeta) {
    const portal = await this.portal(req);
    return this.db.tenant(portal.tenantId, async (tx) => {
      const { buyer, company } = await this.invitation(tx, portal.tenantId, input.token);
      let [user] = await tx.select().from(users).where(eq(users.email, buyer.email));
      if (user) {
        if (!(await verifyPassword(user.passwordHash, input.password)))
          throw new AppError(401, 'INVALID_CREDENTIALS', 'Password is incorrect');
      } else {
        if (!input.displayName)
          throw Errors.validation([{ path: 'displayName', message: 'Enter your name' }]);
        if (input.password.length < PASSWORD_MIN)
          throw Errors.validation([{ path: 'password', message: `Use at least ${PASSWORD_MIN} characters` }]);
        [user] = await tx
          .insert(users)
          .values({
            email: buyer.email,
            displayName: input.displayName,
            passwordHash: await hashPassword(input.password),
          })
          .returning();
      }
      const [claimed] = await tx
        .update(companyBuyers)
        .set({
          userId: user!.id,
          status: 'active',
          invitationTokenHash: null,
          acceptedAt: new Date(),
          version: buyer.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(companyBuyers.id, buyer.id), eq(companyBuyers.status, 'invited')))
        .returning({ id: companyBuyers.id });
      if (!claimed) throw new AppError(400, 'INVITATION_INVALID', 'This invitation was already used');
      await writeAudit(tx, {
        tenantId: portal.tenantId,
        actorType: 'user',
        actorUserId: user!.id,
        action: 'company.buyer_accepted',
        entityType: 'company',
        entityId: company.id,
        newValues: { email: buyer.email, role: buyer.role },
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return { companyName: company.name, email: buyer.email };
    });
  }

  // ---------------------------------------------------------------- catalog & pricing

  private visibleProducts(s: BuyerScope): SQL {
    return and(
      eq(products.status, 'active'),
      sql`exists (select 1 from ${channelPublications} pub where pub.product_id = ${products.id} and pub.channel_id = ${s.channelId} and pub.status = 'published')`,
      s.company.catalogMode === 'collections'
        ? s.company.collectionIds.length
          ? sql`exists (select 1 from ${collectionProducts} cp where cp.product_id = ${products.id} and cp.collection_id in (${sql.join(
              s.company.collectionIds.map((c) => sql`${c}::uuid`),
              sql`, `,
            )}))`
          : sql`false`
        : undefined,
    )!;
  }

  async catalog(s: BuyerScope, q: BuyerCatalogQuery) {
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(s.tenantId, async (tx) => {
      const where: (SQL | undefined)[] = [eq(products.tenantId, s.tenantId), this.visibleProducts(s)];
      if (q.q)
        where.push(
          or(
            ilike(products.title, likePattern(q.q)),
            sql`exists (select 1 from ${variants} v where v.product_id = ${products.id} and v.sku ilike ${likePattern(q.q)})`,
          ),
        );
      if (cursor)
        where.push(
          or(
            sql`${products.title} > ${String(cursor.sortValue)}`,
            and(eq(products.title, String(cursor.sortValue)), sql`${products.id} > ${cursor.id}`),
          ),
        );
      const rows = await tx
        .select()
        .from(products)
        .where(and(...where))
        .orderBy(asc(products.title), asc(products.id))
        .limit(q.limit + 1);
      const page = paginate(rows, q.limit, (r) => r.title);
      const ids = page.items.map((p) => p.id);
      const vs = ids.length
        ? await tx
            .select()
            .from(variants)
            .where(and(inArray(variants.productId, ids), eq(variants.status, 'active')))
            .orderBy(asc(variants.sku))
        : [];
      const moqs =
        vs.length && s.company.priceBookId
          ? await tx
              .select()
              .from(priceListEntries)
              .where(
                and(
                  eq(priceListEntries.bookId, s.company.priceBookId),
                  inArray(
                    priceListEntries.variantId,
                    vs.map((v) => v.id),
                  ),
                ),
              )
          : [];
      return {
        items: page.items.map((p) => ({
          productId: p.id,
          title: p.title,
          variants: vs
            .filter((v) => v.productId === p.id)
            .map((v) => ({
              id: v.id,
              sku: v.sku,
              title: v.title,
              moq: moqs.find((m) => m.variantId === v.id)?.minQuantity ?? null,
            })),
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  /** SKU (+ piece tag) lines → variant lines the company may buy; unknown or hidden items are problems. */
  private async resolveLines(
    tx: Tx,
    s: BuyerScope,
    lines: { sku: string; serialTag: string | null; quantity: number }[],
  ) {
    const problems: Problem[] = [];
    const skus = [...new Set(lines.map((l) => l.sku.toLowerCase()))];
    const found = await tx
      .select({ v: variants, p: products })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(
        and(
          eq(variants.tenantId, s.tenantId),
          inArray(sql`lower(${variants.sku})`, skus),
          eq(variants.status, 'active'),
          this.visibleProducts(s),
        ),
      );
    const inputs: QuoteLineInput[] = [];
    for (const [i, l] of lines.entries()) {
      const hit = found.find((f) => f.v.sku.toLowerCase() === l.sku.toLowerCase());
      if (!hit) {
        problems.push({ line: i, code: 'NOT_FOUND', message: `${l.sku} is not available to your company` });
        continue;
      }
      if (l.serialTag) {
        const [piece] = await tx
          .select({ id: serialItems.id })
          .from(serialItems)
          .where(
            and(
              eq(serialItems.tenantId, s.tenantId),
              eq(serialItems.variantId, hit.v.id),
              sql`lower(${serialItems.serialTag}) = ${l.serialTag.toLowerCase()}`,
            ),
          );
        if (!piece) {
          problems.push({
            line: i,
            code: 'NOT_FOUND',
            message: `Piece ${l.serialTag} of ${l.sku} not found`,
          });
          continue;
        }
        if (l.quantity !== 1)
          problems.push({
            line: i,
            code: 'VALIDATION_FAILED',
            message: 'A piece is ordered with quantity 1',
          });
        inputs.push({ variantId: hit.v.id, serialItemId: piece.id, quantity: 1 });
      } else inputs.push({ variantId: hit.v.id, quantity: l.quantity });
    }
    return { inputs, problems };
  }

  /** MOQ per line (from the company's book entry used to price it) and the company's minimum order value. */
  private async minimums(tx: Tx, s: BuyerScope, priced: QuoteLine[], totalMinor: bigint): Promise<Problem[]> {
    const problems: Problem[] = [];
    for (const [i, l] of priced.entries()) {
      if (l.serialItemId) continue;
      const [entry] = await tx
        .select()
        .from(priceListEntries)
        .where(and(eq(priceListEntries.bookId, l.book.id), eq(priceListEntries.variantId, l.variantId)));
      if (entry?.minQuantity && l.quantity < entry.minQuantity)
        problems.push({
          line: i,
          code: 'MINIMUM_NOT_MET',
          message: `${l.sku}: minimum order quantity is ${entry.minQuantity}`,
        });
    }
    if (s.company.minOrderMinor !== null && totalMinor < s.company.minOrderMinor)
      problems.push({
        line: -1,
        code: 'MINIMUM_NOT_MET',
        message: `The minimum order value for ${s.company.name} is ${s.company.minOrderMinor.toString()} (minor units)`,
      });
    return problems;
  }

  private async priceFor(tx: Tx, s: BuyerScope, inputs: QuoteLineInput[]) {
    const scope = await this.quotes.scope(tx, s, s.channelId, true, s.company.priceBookId);
    return { scope, priced: await this.quotes.priceLines(tx, scope, inputs) };
  }

  private toPriceResponse(row: typeof priceQuotes.$inferSelect, problems: Problem[]): BuyerPriceResponse {
    const view = this.quotes.toStorefrontQuote(row);
    const lines = row.lines as QuoteLine[];
    return {
      quoteId: row.id,
      currency: row.currency,
      totalMinor: row.totalMinor.toString(),
      expiresAt: iso(row.expiresAt),
      lines: lines.map((l, i) => ({
        sku: l.sku,
        title: l.title,
        quantity: l.quantity,
        totalMinor: l.breakdown.totalMinor,
        components: view.lines[i]!.components,
      })),
      problems,
      notes: view.notes,
    };
  }

  async price(s: BuyerScope, input: BuyerPriceRequest): Promise<BuyerPriceResponse> {
    return this.db.tenant(s.tenantId, async (tx) => {
      const { inputs, problems } = await this.resolveLines(tx, s, input.lines);
      if (problems.length)
        throw new AppError(422, 'VALIDATION_FAILED', 'Some lines cannot be ordered', { problems });
      const { scope, priced } = await this.priceFor(tx, s, inputs);
      const row = await this.quotes.insertQuote(tx, scope, inputs, priced, 'storefront', s.userId);
      return this.toPriceResponse(row, await this.minimums(tx, s, priced.priced, priced.totalMinor));
    });
  }

  // ---------------------------------------------------------------- ordering

  private async locationFor(tx: Tx, s: BuyerScope, locationId: string) {
    const [loc] = await tx
      .select()
      .from(companyLocations)
      .where(and(eq(companyLocations.companyId, s.company.id), eq(companyLocations.id, locationId)));
    if (!loc || loc.status !== 'active' || !this.canSeeLocation(s, loc.id))
      throw Errors.validation([{ path: 'locationId', message: 'Choose one of your delivery locations' }]);
    return loc;
  }

  /** Shared by bulk orders and quotation acceptance: credit, buyer limit, merchant approval, holds, charge. */
  private async place(
    tx: Tx,
    s: BuyerScope,
    p: {
      priced: QuoteLine[];
      totals: {
        currency: string;
        subtotalMinor: bigint;
        discountMinor: bigint;
        taxMinor: bigint;
        totalMinor: bigint;
      };
      priceQuoteId: string;
      quotationId?: string | null;
      origin: 'storefront' | 'quotation';
      locationId: string;
      poNumber: string | null;
      note: string | null;
      meta: RequestMeta;
    },
  ): Promise<OrderRow> {
    const loc = await this.locationFor(tx, s, p.locationId);
    await guardCompanyOrder(tx, s.tenantId, s.company.id, p.totals.totalMinor);
    const settings = await loadOrderSettings(tx, s.tenantId);
    const [u] = await tx.select().from(users).where(eq(users.id, s.userId));
    const overBuyer = s.buyer.orderLimitMinor !== null && p.totals.totalMinor > s.buyer.orderLimitMinor;
    const overMerchant =
      settings.approvalThresholdMinor !== null && p.totals.totalMinor >= settings.approvalThresholdMinor;
    const next = overBuyer ? 'awaiting_buyer_approval' : overMerchant ? 'awaiting_approval' : 'confirm';
    const order = await placeOrder(tx, {
      tenantId: s.tenantId,
      channelId: s.channelId,
      origin: p.origin,
      paymentTerms: 'on_account',
      contact: { name: `${u!.displayName} (${s.company.name})`, email: u!.email },
      shippingAddress: loc.address as never,
      note: p.note,
      priced: p.priced,
      ...p.totals,
      priceQuoteId: p.priceQuoteId,
      quotationId: p.quotationId ?? null,
      companyId: s.company.id,
      companyLocationId: loc.id,
      buyerId: s.buyer.id,
      poNumber: p.poNumber,
      next,
      holdMinutes: next === 'confirm' ? settings.checkoutHoldMinutes : APPROVAL_HOLD_MINUTES,
      actorUserId: s.userId,
      correlationId: p.meta.correlationId,
      now: new Date(),
    });
    await chargeCredit(tx, {
      tenantId: s.tenantId,
      companyId: s.company.id,
      orderId: order.id,
      number: order.number,
      totalMinor: order.totalMinor,
      actorUserId: s.userId,
    });
    await writeAudit(tx, {
      tenantId: s.tenantId,
      actorType: 'user',
      actorUserId: s.userId,
      action: 'order.placed_by_buyer',
      entityType: 'order',
      entityId: order.id,
      newValues: {
        number: order.number,
        company: s.company.code,
        totalMinor: order.totalMinor.toString(),
        status: order.status,
      },
      correlationId: p.meta.correlationId,
      ip: p.meta.ip,
    });
    return order;
  }

  async placeOrder(s: BuyerScope, input: BuyerPlaceOrderRequest, meta: RequestMeta): Promise<BuyerOrder> {
    const result = await this.db.tenant(s.tenantId, async (tx) => {
      const [shown] = await tx
        .select()
        .from(priceQuotes)
        .where(
          and(
            eq(priceQuotes.tenantId, s.tenantId),
            eq(priceQuotes.id, input.quoteId),
            eq(priceQuotes.channelId, s.channelId),
            eq(priceQuotes.createdBy, s.userId),
          ),
        );
      if (!shown) throw Errors.notFound('Quote');
      if (input.acknowledgedTotalMinor !== shown.totalMinor.toString())
        throw new AppError(
          422,
          'VALIDATION_FAILED',
          'The acknowledged total does not match the quote you were shown',
        );
      const lines = shown.lineInputs as QuoteLineInput[];
      const { scope, priced } = await this.priceFor(tx, s, lines);
      if (priced.totalMinor !== shown.totalMinor) {
        const fresh = await this.quotes.insertQuote(tx, scope, lines, priced, 'storefront', s.userId);
        return { changed: this.toPriceResponse(fresh, []) };
      }
      const problems = await this.minimums(tx, s, priced.priced, priced.totalMinor);
      if (problems.length)
        throw new AppError(422, 'MINIMUM_NOT_MET', problems.map((p) => p.message).join('; '), { problems });
      const order = await this.place(tx, s, {
        priced: priced.priced,
        totals: priced,
        priceQuoteId: shown.id,
        origin: 'storefront',
        locationId: input.locationId,
        poNumber: input.poNumber,
        note: input.note,
        meta,
      });
      return { order: await this.toBuyerOrder(tx, order) };
    });
    if ('changed' in result && result.changed)
      throw new AppError(
        409,
        'PRICE_CHANGED',
        'Prices changed since you were quoted. Review the new total.',
        { quote: result.changed },
      );
    return (result as { order: BuyerOrder }).order;
  }

  private async toBuyerOrder(tx: Tx, o: OrderRow): Promise<BuyerOrder> {
    const [lines, [loc], [placer]] = await Promise.all([
      tx.select().from(orderLines).where(eq(orderLines.orderId, o.id)).orderBy(asc(orderLines.lineNo)),
      o.companyLocationId
        ? tx.select().from(companyLocations).where(eq(companyLocations.id, o.companyLocationId))
        : Promise.resolve([]),
      o.createdBy
        ? tx.select({ name: users.displayName }).from(users).where(eq(users.id, o.createdBy))
        : Promise.resolve([]),
    ]);
    return {
      ...toSummary(o, null, lines.length),
      poNumber: o.poNumber,
      location: loc ? { id: loc.id, name: loc.name } : null,
      placedBy: placer?.name ?? null,
      lines: lines.map((l) => ({
        sku: l.sku,
        title: l.title,
        serialTag: l.serialTag,
        quantity: l.quantity,
        totalMinor: l.totalMinor.toString(),
      })),
      approvalNote: o.buyerApprovalNote,
    };
  }

  private orderScope(s: BuyerScope): SQL {
    return and(
      eq(orders.tenantId, s.tenantId),
      eq(orders.companyId, s.company.id),
      s.buyer.locationIds
        ? s.buyer.locationIds.length
          ? inArray(orders.companyLocationId, s.buyer.locationIds)
          : sql`false`
        : undefined,
    )!;
  }

  async orders(s: BuyerScope, q: BuyerOrderListQuery): Promise<Page<OrderSummary>> {
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(s.tenantId, async (tx) => {
      const where: (SQL | undefined)[] = [
        this.orderScope(s),
        q.status ? sql`${orders.status} = ${q.status}` : undefined,
      ];
      if (cursor) {
        const at = new Date(String(cursor.sortValue));
        where.push(or(lt(orders.createdAt, at), and(eq(orders.createdAt, at), lt(orders.id, cursor.id))));
      }
      const rows = await tx
        .select({
          o: orders,
          n: sql<number>`(select count(*)::int from ${orderLines} l where l.order_id = ${orders.id})`,
        })
        .from(orders)
        .where(and(...where))
        .orderBy(desc(orders.createdAt), desc(orders.id))
        .limit(q.limit + 1);
      return paginate(
        rows.map((r) => toSummary(r.o, null, r.n)),
        q.limit,
        (r) => r.createdAt,
      );
    });
  }

  private async loadOrder(tx: Tx, s: BuyerScope, id: string, lock = false): Promise<OrderRow> {
    const q = tx
      .select()
      .from(orders)
      .where(and(this.orderScope(s), eq(orders.id, id)));
    const [o] = lock ? await q.for('update') : await q;
    if (!o) throw Errors.notFound('Order');
    return o;
  }

  async order(s: BuyerScope, id: string): Promise<BuyerOrder> {
    return this.db.tenant(s.tenantId, async (tx) => this.toBuyerOrder(tx, await this.loadOrder(tx, s, id)));
  }

  /** Company approvers/admins approve orders over a buyer's limit; never the buyer who placed it. */
  async decide(
    s: BuyerScope,
    id: string,
    approve: boolean,
    input: BuyerDecisionRequest,
    meta: RequestMeta,
  ): Promise<BuyerOrder> {
    if (s.buyer.role === 'buyer')
      throw new AppError(403, 'PERMISSION_DENIED', 'Only company approvers can approve orders');
    return this.db.tenant(s.tenantId, async (tx) => {
      const o = await this.loadOrder(tx, s, id, true);
      if (o.status !== 'awaiting_buyer_approval')
        throw new AppError(
          409,
          'INVALID_STATE_TRANSITION',
          `Order ${o.number} is ${o.status.replace(/_/g, ' ')}`,
        );
      if (o.buyerId === s.buyer.id)
        throw new AppError(
          403,
          'SEPARATION_OF_DUTIES',
          'You placed this order; another approver must decide',
        );
      const now = new Date();
      if (!approve) {
        if (!input.reason || input.reason.length < 5)
          throw Errors.validation([{ path: 'reason', message: 'Give a reason of at least 5 characters' }]);
        const after = await cancelOrder(tx, o, {
          actorUserId: s.userId,
          correlationId: meta.correlationId,
          reason: input.reason,
          type: 'buyer_rejected',
        });
        return this.toBuyerOrder(tx, after);
      }
      const settings = await loadOrderSettings(tx, s.tenantId);
      const [stamped] = await tx
        .update(orders)
        .set({
          buyerApprovedBy: s.userId,
          buyerApprovedAt: now,
          buyerApprovalNote: input.note ?? null,
          updatedAt: now,
        })
        .where(eq(orders.id, o.id))
        .returning();
      await addOrderEvent(tx, {
        tenantId: s.tenantId,
        orderId: o.id,
        type: 'buyer_approved',
        fromStatus: o.status,
        actorUserId: s.userId,
        note: input.note ?? null,
        at: now,
      });
      let after: OrderRow;
      if (settings.approvalThresholdMinor !== null && o.totalMinor >= settings.approvalThresholdMinor) {
        [after] = (await tx
          .update(orders)
          .set({
            status: 'awaiting_approval',
            expiresAt: new Date(now.getTime() + APPROVAL_HOLD_MINUTES * 60_000),
            updatedAt: now,
          })
          .where(eq(orders.id, o.id))
          .returning()) as [OrderRow];
        await addOrderEvent(tx, {
          tenantId: s.tenantId,
          orderId: o.id,
          type: 'sent_for_approval',
          fromStatus: 'awaiting_buyer_approval',
          toStatus: 'awaiting_approval',
          actorUserId: s.userId,
          at: now,
        });
      } else {
        ({ order: after } = await confirmOrder(tx, stamped!, {
          actorUserId: s.userId,
          correlationId: meta.correlationId,
          now,
        }));
      }
      await writeAudit(tx, {
        tenantId: s.tenantId,
        actorType: 'user',
        actorUserId: s.userId,
        action: 'order.buyer_approved',
        entityType: 'order',
        entityId: o.id,
        newValues: { status: after.status },
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return this.toBuyerOrder(tx, after);
    });
  }

  // ---------------------------------------------------------------- RFQs & quotations

  private rfqScope(s: BuyerScope): SQL {
    return and(
      eq(rfqs.tenantId, s.tenantId),
      eq(rfqs.companyId, s.company.id),
      s.buyer.locationIds
        ? or(
            sql`${rfqs.locationId} is null`,
            s.buyer.locationIds.length ? inArray(rfqs.locationId, s.buyer.locationIds) : sql`false`,
          )
        : undefined,
    )!;
  }

  async createRfq(s: BuyerScope, input: BuyerRfqRequest, meta: RequestMeta): Promise<Rfq> {
    return this.db.tenant(s.tenantId, async (tx) => {
      if (input.locationId) await this.locationFor(tx, s, input.locationId);
      const { inputs, problems } = await this.resolveLines(tx, s, input.lines);
      if (problems.length)
        throw new AppError(422, 'VALIDATION_FAILED', 'Some lines cannot be requested', { problems });
      const [row] = await tx
        .insert(rfqs)
        .values({
          tenantId: s.tenantId,
          number: await nextDocumentNumber(tx, s.tenantId, 'rfq'),
          companyId: s.company.id,
          buyerId: s.buyer.id,
          locationId: input.locationId,
          lines: inputs.map((l, i) => ({ ...l, note: input.lines[i]!.note })),
          note: input.note,
          neededBy: input.neededBy ? new Date(input.neededBy) : null,
        })
        .returning();
      if (input.note)
        await tx.insert(rfqMessages).values({
          tenantId: s.tenantId,
          rfqId: row!.id,
          author: 'buyer',
          authorUserId: s.userId,
          body: input.note,
        });
      await writeAudit(tx, {
        tenantId: s.tenantId,
        actorType: 'user',
        actorUserId: s.userId,
        action: 'rfq.submitted',
        entityType: 'rfq',
        entityId: row!.id,
        newValues: { number: row!.number, lines: inputs.length },
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return toRfq(tx, row!);
    });
  }

  async rfqList(s: BuyerScope, q: { limit: number; cursor?: string }) {
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(s.tenantId, async (tx) => {
      const where: (SQL | undefined)[] = [this.rfqScope(s)];
      if (cursor) {
        const at = new Date(String(cursor.sortValue));
        where.push(or(lt(rfqs.createdAt, at), and(eq(rfqs.createdAt, at), lt(rfqs.id, cursor.id))));
      }
      const rows = await tx
        .select()
        .from(rfqs)
        .where(and(...where))
        .orderBy(desc(rfqs.createdAt), desc(rfqs.id))
        .limit(q.limit + 1);
      const page = paginate(rows, q.limit, (r) => iso(r.createdAt));
      return { items: await Promise.all(page.items.map((r) => toRfq(tx, r))), nextCursor: page.nextCursor };
    });
  }

  private async loadRfq(tx: Tx, s: BuyerScope, id: string) {
    const [r] = await tx
      .select()
      .from(rfqs)
      .where(and(this.rfqScope(s), eq(rfqs.id, id)));
    if (!r) throw Errors.notFound('RFQ');
    return r;
  }

  async rfq(s: BuyerScope, id: string): Promise<Rfq> {
    return this.db.tenant(s.tenantId, async (tx) => toRfq(tx, await this.loadRfq(tx, s, id)));
  }

  async rfqMessage(s: BuyerScope, id: string, input: RfqMessageRequest): Promise<Rfq> {
    return this.db.tenant(s.tenantId, async (tx) => {
      const r = await this.loadRfq(tx, s, id);
      if (!['submitted', 'quoted'].includes(r.status))
        throw new AppError(409, 'INVALID_STATE_TRANSITION', `RFQ ${r.number} is ${r.status}`);
      await tx.insert(rfqMessages).values({
        tenantId: s.tenantId,
        rfqId: r.id,
        author: 'buyer',
        authorUserId: s.userId,
        body: input.body,
      });
      return toRfq(tx, r);
    });
  }

  private async toBuyerQuotation(tx: Tx, q: typeof quotations.$inferSelect): Promise<BuyerQuotation> {
    const [pq] = q.priceQuoteId
      ? await tx.select().from(priceQuotes).where(eq(priceQuotes.id, q.priceQuoteId))
      : [];
    const lines = (pq?.lines as QuoteLine[] | undefined) ?? [];
    return {
      id: q.id,
      number: q.number,
      status: q.status === 'sent' && q.validUntil.getTime() <= Date.now() ? 'expired' : q.status,
      rfqId: q.rfqId,
      validUntil: iso(q.validUntil),
      currency: pq?.currency ?? null,
      totalMinor: pq ? pq.totalMinor.toString() : null,
      lines: lines.map((l, index) => ({
        index,
        sku: l.sku,
        title: l.title,
        quantity: l.quantity,
        totalMinor: l.breakdown.totalMinor,
      })),
      notes: q.notes,
      orderId: q.orderId,
    };
  }

  async quotations(s: BuyerScope): Promise<{ items: BuyerQuotation[] }> {
    return this.db.tenant(s.tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(quotations)
        .where(
          and(
            eq(quotations.tenantId, s.tenantId),
            eq(quotations.companyId, s.company.id),
            inArray(quotations.status, ['sent', 'accepted', 'converted', 'expired']),
          ),
        )
        .orderBy(desc(quotations.createdAt))
        .limit(100);
      return { items: await Promise.all(rows.map((r) => this.toBuyerQuotation(tx, r))) };
    });
  }

  /** Partial acceptance: chosen quoted lines become an order at the frozen price, before the quotation expires. */
  async acceptQuotation(
    s: BuyerScope,
    id: string,
    input: BuyerAcceptQuotationRequest,
    meta: RequestMeta,
  ): Promise<BuyerOrder> {
    return this.db.tenant(s.tenantId, async (tx) => {
      const [q] = await tx
        .select()
        .from(quotations)
        .where(
          and(
            eq(quotations.tenantId, s.tenantId),
            eq(quotations.companyId, s.company.id),
            eq(quotations.id, id),
          ),
        )
        .for('update');
      if (!q) throw Errors.notFound('Quotation');
      if (q.status !== 'sent')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', `Quotation ${q.number} is ${q.status}`);
      if (q.validUntil.getTime() <= Date.now())
        throw new AppError(409, 'QUOTE_EXPIRED', `Quotation ${q.number} expired on ${iso(q.validUntil)}`);
      const [pq] = await tx.select().from(priceQuotes).where(eq(priceQuotes.id, q.priceQuoteId!));
      const all = pq!.lines as QuoteLine[];
      const idx = input.lineIndexes
        ? [...new Set(input.lineIndexes)].sort((a, b) => a - b)
        : all.map((_, i) => i);
      if (idx.some((i) => i >= all.length))
        throw Errors.validation([{ path: 'lineIndexes', message: 'Unknown quotation line' }]);
      const chosen = idx.map((i) => all[i]!);
      const sum = (k: 'subtotalMinor' | 'discountMinor' | 'taxMinor' | 'totalMinor') =>
        chosen.reduce((a, l) => a + BigInt(l.breakdown[k]), 0n);
      const order = await this.place(tx, s, {
        priced: chosen,
        totals: {
          currency: pq!.currency,
          subtotalMinor: sum('subtotalMinor'),
          discountMinor: sum('discountMinor'),
          taxMinor: sum('taxMinor'),
          totalMinor: sum('totalMinor'),
        },
        priceQuoteId: pq!.id,
        quotationId: q.id,
        origin: 'quotation',
        locationId: input.locationId,
        poNumber: input.poNumber,
        note: `From quotation ${q.number}${chosen.length < all.length ? ` (${chosen.length} of ${all.length} lines)` : ''}`,
        meta,
      });
      const [u] = await tx.select().from(users).where(eq(users.id, s.userId));
      await tx
        .update(quotations)
        .set({
          status: 'converted',
          acceptedAt: new Date(),
          acceptanceNote: `Accepted in the buyer portal by ${u!.displayName} (${u!.email}): lines ${idx.map((i) => i + 1).join(', ')}`,
          orderId: order.id,
          version: q.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(quotations.id, q.id));
      if (q.rfqId)
        await tx.update(rfqs).set({ status: 'accepted', updatedAt: new Date() }).where(eq(rfqs.id, q.rfqId));
      await enqueueEvent(tx, {
        tenantId: s.tenantId,
        eventType: 'QuoteAccepted',
        aggregateType: 'quotation',
        aggregateId: q.id,
        correlationId: meta.correlationId,
        payload: { quotationId: q.id, orderId: order.id, lines: idx },
      });
      return this.toBuyerOrder(tx, order);
    });
  }
}
