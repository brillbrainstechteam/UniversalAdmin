import { timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  Cart,
  CheckoutRequest,
  FeatureKey,
  QuoteLineInput,
  StorefrontOrder,
  StorefrontQuote,
} from '@uc/contracts';
import {
  carts,
  generateToken,
  orderLines,
  orders,
  payments,
  priceQuotes,
  sha256,
  type OrderRow,
  type Tx,
} from '@uc/db';
import { and, asc, desc, eq } from 'drizzle-orm';
import { AppError, Errors } from '../../common/errors';
import { iso } from '../../common/mappers';
import { DbService } from '../../db/db.service';
import { QuoteService } from '../pricing/quote.service';
import { loadOrderSettings, placeOrder, requireOrders } from './orders.common';
import { PaymentsService } from './payments.service';

export interface StorefrontScope {
  tenantId: string;
  channelId: string;
  features: readonly FeatureKey[];
  /** Phase 09: the signed-in customer placing the order (null for guests). */
  customerId?: string | null;
}

type CartRow = typeof carts.$inferSelect;
const CART_DAYS = 7;

function tokenMatches(token: string, hash: string): boolean {
  const a = Buffer.from(sha256(token), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Same lines (variant, piece, quantity) in the same order. */
function sameLines(a: QuoteLineInput[], b: QuoteLineInput[]): boolean {
  const key = (l: QuoteLineInput) => `${l.variantId}:${l.serialItemId ?? ''}:${l.quantity}`;
  return a.length === b.length && a.every((l, i) => key(l) === key(b[i]!));
}

/**
 * Storefront cart and checkout (ADR-022). The server prices everything; the shopper only acknowledges a total it
 * was shown. Checkout re-prices, refuses a changed price (409 PRICE_CHANGED + the new quote to acknowledge),
 * holds every line all-or-nothing and creates the order with a sandbox payment.
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly db: DbService,
    private readonly quotes: QuoteService,
    private readonly payments: PaymentsService,
  ) {}

  private gate(s: StorefrontScope) {
    if (!s.features.includes('orders') || !s.features.includes('pricing')) throw Errors.notFound('Checkout');
    requireOrders(s);
  }

  private async loadCart(
    tx: Tx,
    s: StorefrontScope,
    id: string,
    token: string | undefined,
    lock = false,
  ): Promise<CartRow> {
    const q = tx
      .select()
      .from(carts)
      .where(and(eq(carts.tenantId, s.tenantId), eq(carts.id, id), eq(carts.channelId, s.channelId)));
    const [cart] = lock ? await q.for('update') : await q;
    // Wrong token and unknown cart look the same to the caller.
    if (!cart || !token || !tokenMatches(token, cart.tokenHash)) throw Errors.notFound('Cart');
    return cart;
  }

  private async priceCart(
    tx: Tx,
    s: StorefrontScope,
    lines: QuoteLineInput[],
  ): Promise<StorefrontQuote | null> {
    if (!lines.length) return null;
    const scope = await this.quotes.scope(tx, s, s.channelId, true);
    const priced = await this.quotes.priceLines(tx, scope, lines);
    return this.quotes.toStorefrontQuote(
      await this.quotes.insertQuote(tx, scope, lines, priced, 'storefront', null),
    );
  }

  private toCart(cart: CartRow, quote: StorefrontQuote | null): Cart {
    const lines = cart.lines as QuoteLineInput[];
    return {
      id: cart.id,
      status: cart.status,
      lines: lines.map((l) => ({
        variantId: l.variantId,
        serialItemId: l.serialItemId ?? null,
        quantity: l.quantity,
      })),
      quote,
      orderId: cart.orderId,
    };
  }

  async createCart(s: StorefrontScope) {
    this.gate(s);
    const token = generateToken();
    const expiresAt = new Date(Date.now() + CART_DAYS * 24 * 3600_000);
    const [cart] = await this.db.tenant(s.tenantId, (tx) =>
      tx
        .insert(carts)
        .values({
          tenantId: s.tenantId,
          channelId: s.channelId,
          tokenHash: sha256(token),
          lines: [],
          expiresAt,
        })
        .returning(),
    );
    return { cartId: cart!.id, cartToken: token, expiresAt: iso(expiresAt) };
  }

  async getCart(s: StorefrontScope, id: string, token: string | undefined): Promise<Cart> {
    this.gate(s);
    return this.db.tenant(s.tenantId, async (tx) => {
      const cart = await this.loadCart(tx, s, id, token);
      return this.toCart(
        cart,
        cart.status === 'open' ? await this.priceCart(tx, s, cart.lines as QuoteLineInput[]) : null,
      );
    });
  }

  /** Replaces the cart's lines; every line is validated by pricing it (visibility, pieces, rules, rates). */
  async putLines(
    s: StorefrontScope,
    id: string,
    token: string | undefined,
    lines: QuoteLineInput[],
  ): Promise<Cart> {
    this.gate(s);
    return this.db.tenant(s.tenantId, async (tx) => {
      const cart = await this.loadCart(tx, s, id, token, true);
      if (cart.status !== 'open')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', 'This cart was already checked out');
      const quote = await this.priceCart(tx, s, lines);
      const [after] = await tx
        .update(carts)
        .set({ lines, updatedAt: new Date(), version: cart.version + 1 })
        .where(eq(carts.id, cart.id))
        .returning();
      return this.toCart(after!, quote);
    });
  }

  async checkout(s: StorefrontScope, input: CheckoutRequest, key: string): Promise<StorefrontOrder> {
    this.gate(s);
    const result = await this.db.tenant(s.tenantId, async (tx) => {
      const cart = await this.loadCart(tx, s, input.cartId, input.cartToken, true);
      if (cart.status !== 'open')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', 'This cart was already checked out');
      const lines = cart.lines as QuoteLineInput[];
      if (!lines.length) throw Errors.validation([{ path: 'cartId', message: 'The cart is empty' }]);
      const [shown] = await tx
        .select()
        .from(priceQuotes)
        .where(
          and(
            eq(priceQuotes.tenantId, s.tenantId),
            eq(priceQuotes.id, input.quoteId),
            eq(priceQuotes.channelId, s.channelId),
          ),
        );
      if (!shown || !sameLines(shown.lineInputs as QuoteLineInput[], lines))
        throw new AppError(
          422,
          'VALIDATION_FAILED',
          'This quote is not for the current cart; refresh the cart to get a price',
        );
      if (input.acknowledgedTotalMinor !== shown.totalMinor.toString())
        throw new AppError(
          422,
          'VALIDATION_FAILED',
          'The acknowledged total does not match the quote you were shown',
        );
      // Authoritative re-price with current rates and rules.
      const scope = await this.quotes.scope(tx, s, s.channelId, true);
      const priced = await this.quotes.priceLines(tx, scope, lines);
      if (priced.totalMinor !== shown.totalMinor || priced.currency !== shown.currency) {
        const fresh = await this.quotes.insertQuote(tx, scope, lines, priced, 'storefront', null);
        return { changed: this.quotes.toStorefrontQuote(fresh) };
      }
      // Same price: freeze it as the order's quote (fresh record if the shown one expired).
      const quote =
        shown.expiresAt.getTime() > scope.now.getTime()
          ? shown
          : await this.quotes.insertQuote(tx, scope, lines, priced, 'storefront', null);
      const settings = await loadOrderSettings(tx, s.tenantId);
      const order = await placeOrder(tx, {
        tenantId: s.tenantId,
        channelId: s.channelId,
        origin: 'storefront',
        paymentTerms: 'prepaid',
        contact: input.contact,
        shippingAddress: input.shippingAddress,
        note: null,
        priced: priced.priced,
        currency: priced.currency,
        subtotalMinor: priced.subtotalMinor,
        discountMinor: priced.discountMinor,
        taxMinor: priced.taxMinor,
        totalMinor: priced.totalMinor,
        priceQuoteId: quote.id,
        cartId: cart.id,
        checkoutKey: key,
        customerId: s.customerId ?? null,
        next: 'pending_payment',
        holdMinutes: settings.checkoutHoldMinutes,
        actorUserId: null,
        correlationId: null,
        now: scope.now,
      });
      await tx
        .update(carts)
        .set({ status: 'converted', orderId: order.id, updatedAt: scope.now })
        .where(eq(carts.id, cart.id));
      return { order: await this.toStorefrontOrder(tx, order) };
    });
    if ('changed' in result && result.changed)
      throw new AppError(
        409,
        'PRICE_CHANGED',
        'The price changed since it was shown. Review and acknowledge the new total.',
        {
          quote: result.changed,
        },
      );
    return (result as { order: StorefrontOrder }).order;
  }

  private async orderForCart(
    tx: Tx,
    s: StorefrontScope,
    orderId: string,
    token: string | undefined,
  ): Promise<OrderRow> {
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.tenantId, s.tenantId), eq(orders.id, orderId), eq(orders.channelId, s.channelId)));
    if (!order?.cartId) throw Errors.notFound('Order');
    await this.loadCart(tx, s, order.cartId, token);
    return order;
  }

  async getOrder(s: StorefrontScope, orderId: string, token: string | undefined): Promise<StorefrontOrder> {
    this.gate(s);
    return this.db.tenant(s.tenantId, async (tx) =>
      this.toStorefrontOrder(tx, await this.orderForCart(tx, s, orderId, token)),
    );
  }

  /** Sandbox only: the shopper "pays" on the simulated PSP; the signed callback drives the order. */
  async sandboxPay(
    s: StorefrontScope,
    orderId: string,
    token: string,
    outcome: 'succeeded' | 'failed',
  ): Promise<StorefrontOrder> {
    this.gate(s);
    await this.db.tenant(s.tenantId, (tx) => this.orderForCart(tx, s, orderId, token));
    await this.payments.simulate(s.tenantId, orderId, outcome);
    return this.getOrder(s, orderId, token);
  }

  private async toStorefrontOrder(tx: Tx, o: OrderRow): Promise<StorefrontOrder> {
    const [lines, [payment]] = await Promise.all([
      tx.select().from(orderLines).where(eq(orderLines.orderId, o.id)).orderBy(asc(orderLines.lineNo)),
      tx.select().from(payments).where(eq(payments.orderId, o.id)).orderBy(desc(payments.createdAt)).limit(1),
    ]);
    return {
      id: o.id,
      number: o.number,
      status: o.status,
      paymentStatus: o.paymentStatus,
      fulfillmentStatus: o.fulfillmentStatus,
      currency: o.currency,
      totalMinor: o.totalMinor.toString(),
      lines: lines.map((l) => ({
        title: l.title,
        quantity: l.quantity,
        totalMinor: l.totalMinor.toString(),
      })),
      payment: payment
        ? {
            id: payment.id,
            status: payment.status,
            sandbox: true,
            amountMinor: payment.amountMinor.toString(),
          }
        : null,
      expiresAt: o.expiresAt ? iso(o.expiresAt) : null,
      createdAt: iso(o.createdAt),
    };
  }
}
