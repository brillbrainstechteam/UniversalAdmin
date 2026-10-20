import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ADAPTERS } from '@uc/connector-sdk';
import {
  createDb,
  expireOrders,
  expireQuotations,
  relayOutboundCommands,
  requireEnv,
  systemTx,
  type OrderPushAdapter,
} from '@uc/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalPayload } from '../../src/modules/orders/payments.service';
import {
  CSRF,
  auditCount,
  createMember,
  locationId,
  login,
  ownerPool,
  startApp,
  tenantId,
  type Agent,
} from '../helpers';

/** Phase 07 acceptance (O-01 … O-11). Every test builds its own products/stock so demo data is not consumed. */
let app: INestApplication;
let northwind: string;
let lumiere: string;
let aurum: string;
let nwMain: string;
let lumMain: string;
let aurMain: string;
let nwChannel: string;
const worker = createDb(requireEnv('TEST_DATABASE_URL'), { max: 2 });
const SANDBOX_SECRET = 'dev-only-sandbox-payment-signing-secret-0123456789';

function scoped(agent: Agent, tenant: string) {
  return {
    get: (p: string) => agent.get(p).set('x-tenant-id', tenant),
    post: (p: string, key?: string) => {
      const r = agent.post(p).set('x-tenant-id', tenant).set(CSRF);
      return key ? r.set('idempotency-key', key) : r;
    },
    put: (p: string) => agent.put(p).set('x-tenant-id', tenant).set(CSRF),
    patch: (p: string) => agent.patch(p).set('x-tenant-id', tenant).set(CSRF),
  };
}
type Client = ReturnType<typeof scoped>;
let nw: Client; // owner
let nwAdmin: Client; // second person with orders.approve
let nwViewer: Client;
let lu: Client;
let luRates: Client;
let au: Client;
let auRates: Client;

let seq = 0;
const uid = () => `${Date.now().toString(36)}${++seq}`.toUpperCase();
const key = () => `key-${uid()}-${Math.random().toString(36).slice(2, 8)}`;
const one = async <T = Record<string, unknown>>(q: string, params: unknown[]) =>
  (await ownerPool.query(q, params)).rows[0] as T;
const sf = (host: string) => ({
  get: (p: string) => request(app.getHttpServer()).get(p).set('Host', host),
  post: (p: string) => request(app.getHttpServer()).post(p).set('Host', host),
  put: (p: string) => request(app.getHttpServer()).put(p).set('Host', host),
});
const NW = 'northwind.localhost';
const LUM = 'lumiere.localhost';
const contact = { name: 'Test Shopper', email: 'shopper@example.test' };
const address = { line1: '1 Test Street', city: 'London', countryCode: 'GB' };
const bal = async (variantId: string, loc: string) =>
  (await one<{ on_hand: string; reserved: string; committed: string }>(
    "select on_hand, reserved, committed from stock_balances where variant_id = $1 and location_id = $2 and condition = 'sellable'",
    [variantId, loc],
  )) ?? { on_hand: '0', reserved: '0', committed: '0' };

/** Published Northwind product with a list price and stock. */
async function nwItem(price: string, stock: string) {
  const sku = `ORD-${uid()}`;
  const p = await nw.post('/v1/admin/products').send({ title: `Order item ${sku}`, variants: [{ sku }] });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  await nw.patch(`/v1/admin/products/${p.body.id}`).send({ version: 0, status: 'active' }).expect(200);
  await nw.put(`/v1/admin/products/${p.body.id}/publications/${nwChannel}`).expect(200);
  const variantId = p.body.variants[0].id as string;
  const book = (await nw.get('/v1/admin/pricing/books')).body.items[0].id;
  await nw
    .put(`/v1/admin/pricing/books/${book}/list-prices`)
    .send({ items: [{ variantId, amount: price }] })
    .expect(200);
  if (stock !== '0')
    await nw
      .post('/v1/admin/inventory/receipts', key())
      .send({ locationId: nwMain, lines: [{ variantId, quantity: stock }] })
      .expect(201);
  return { variantId, sku, productId: p.body.id as string, book };
}

async function cartWith(host: string, lines: unknown[]) {
  const c = await sf(host).post('/v1/storefront/carts');
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  const put = await sf(host)
    .put(`/v1/storefront/carts/${c.body.cartId}/lines`)
    .set('x-cart-token', c.body.cartToken)
    .send({ lines });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  return {
    id: c.body.cartId as string,
    token: c.body.cartToken as string,
    quote: put.body.quote as { id: string; totalMinor: string },
  };
}

function checkout(
  host: string,
  cart: { id: string; token: string; quote: { id: string; totalMinor: string } },
  k = key(),
  extra: Record<string, unknown> = {},
) {
  return sf(host)
    .post('/v1/storefront/checkouts')
    .set('idempotency-key', k)
    .send({
      cartId: cart.id,
      cartToken: cart.token,
      quoteId: cart.quote.id,
      acknowledgedTotalMinor: cart.quote.totalMinor,
      contact,
      shippingAddress: address,
      ...extra,
    });
}

function signed(event: Record<string, string>) {
  const sig = createHmac('sha256', SANDBOX_SECRET)
    .update(canonicalPayload(event as never))
    .digest('hex');
  return request(app.getHttpServer())
    .post('/v1/payments/sandbox/webhook')
    .set('x-sandbox-signature', sig)
    .send(event);
}

beforeAll(async () => {
  app = await startApp();
  northwind = await tenantId('northwind-general');
  lumiere = await tenantId('lumiere-fine');
  aurum = await tenantId('aurum-wholesale');
  nwMain = (
    await one<{ id: string }>('select id from locations where tenant_id = $1 order by created_at limit 1', [
      northwind,
    ])
  ).id;
  lumMain = (
    await one<{ id: string }>('select id from locations where tenant_id = $1 order by created_at limit 1', [
      lumiere,
    ])
  ).id;
  aurMain = await locationId('aurum-wholesale', 'main-wh');
  nwChannel = (
    await one<{ id: string }>(
      "select channel_id as id from channel_domains where hostname = 'northwind.localhost'",
      [],
    )
  ).id;
  nw = scoped(await login(app, 'owner@northwind.demo'), northwind);
  nwAdmin = scoped(await login(app, (await createMember(northwind, ['admin'])).email), northwind);
  nwViewer = scoped(await login(app, (await createMember(northwind, ['viewer'])).email), northwind);
  lu = scoped(await login(app, 'owner@lumiere.demo'), lumiere);
  luRates = scoped(await login(app, (await createMember(lumiere, ['rate_approver'])).email), lumiere);
  au = scoped(await login(app, 'owner@aurum.demo'), aurum);
  auRates = scoped(await login(app, 'rates@aurum.demo'), aurum);
});
afterAll(async () => {
  await app.close();
  await worker.close();
});

describe('cart (O-01)', () => {
  it('requires the cart token, validates items by pricing them, and stays on its own storefront', async () => {
    const item = await nwItem('10.00', '5');
    const c = await sf(NW).post('/v1/storefront/carts');
    expect(c.body.cartToken.length).toBeGreaterThan(30);
    expect((await sf(NW).get(`/v1/storefront/carts/${c.body.cartId}`)).status).toBe(404);
    expect(
      (await sf(NW).get(`/v1/storefront/carts/${c.body.cartId}`).set('x-cart-token', 'x'.repeat(43))).status,
    ).toBe(404);
    expect(
      (await sf(LUM).get(`/v1/storefront/carts/${c.body.cartId}`).set('x-cart-token', c.body.cartToken))
        .status,
    ).toBe(404);
    const auVariant = (
      await one<{ id: string }>("select id from variants where tenant_id = $1 and sku = 'AUR-BAND22-14'", [
        aurum,
      ])
    ).id;
    const foreign = await sf(NW)
      .put(`/v1/storefront/carts/${c.body.cartId}/lines`)
      .set('x-cart-token', c.body.cartToken)
      .send({ lines: [{ variantId: auVariant }] });
    expect(foreign.status).toBe(404);
    const draftSku = `DRAFT-${uid()}`;
    await nw
      .post('/v1/admin/products')
      .send({ title: draftSku, variants: [{ sku: draftSku }] })
      .expect(201);
    const draftV = (await one<{ id: string }>('select id from variants where sku = $1', [draftSku])).id;
    expect(
      (
        await sf(NW)
          .put(`/v1/storefront/carts/${c.body.cartId}/lines`)
          .set('x-cart-token', c.body.cartToken)
          .send({ lines: [{ variantId: draftV }] })
      ).status,
    ).toBe(404);
    const ok = await sf(NW)
      .put(`/v1/storefront/carts/${c.body.cartId}/lines`)
      .set('x-cart-token', c.body.cartToken)
      .send({ lines: [{ variantId: item.variantId, quantity: 3 }] });
    expect(ok.body).toMatchObject({
      status: 'open',
      lines: [{ quantity: 3 }],
      quote: { currency: 'GBP', totalMinor: '3000' },
    });
  });
});

describe('checkout, payment, cancellation (O-02, O-04, O-08)', () => {
  let item: Awaited<ReturnType<typeof nwItem>>;
  let orderId: string;
  let cartToken: string;

  it('re-prices: a changed price needs a new acknowledgement; the client never sets the total; replay returns the same order', async () => {
    item = await nwItem('10.00', '5');
    const cart = await cartWith(NW, [{ variantId: item.variantId, quantity: 2 }]);
    cartToken = cart.token;
    expect(cart.quote.totalMinor).toBe('2000');
    expect((await checkout(NW, cart, key(), { acknowledgedTotalMinor: '1' })).status).toBe(422);
    await nw
      .put(`/v1/admin/pricing/books/${item.book}/list-prices`)
      .send({ items: [{ variantId: item.variantId, amount: '12.00' }] })
      .expect(200);
    const changed = await checkout(NW, cart);
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ code: 'PRICE_CHANGED', details: { quote: { totalMinor: '2400' } } });
    expect((await bal(item.variantId, nwMain)).reserved).toBe('0.000000'); // nothing held
    expect((await sf(NW).post('/v1/storefront/checkouts').send({})).status).toBe(400);

    const acknowledged = { ...cart, quote: changed.body.details.quote };
    const k = key();
    const placed = await checkout(NW, acknowledged, k);
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect(placed.body).toMatchObject({
      status: 'pending_payment',
      paymentStatus: 'pending',
      totalMinor: '2400',
      currency: 'GBP',
    });
    expect(placed.body.number).toMatch(/^ORD-\d{6}$/);
    orderId = placed.body.id;
    const replay = await checkout(NW, acknowledged, k);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(orderId);
    expect((await checkout(NW, acknowledged)).status).toBe(409); // cart already checked out
    expect((await bal(item.variantId, nwMain)).reserved).toBe('2.000000');
    const status = await sf(NW).get(`/v1/storefront/orders/${orderId}`).set('x-cart-token', cartToken);
    expect(status.body).toMatchObject({
      number: placed.body.number,
      lines: [{ quantity: 2, totalMinor: '2400' }],
    });
    expect(
      (await sf(NW).get(`/v1/storefront/orders/${orderId}`).set('x-cart-token', 'y'.repeat(43))).status,
    ).toBe(404);
  });

  it('sandbox payment: forged callbacks rejected, decline keeps the order payable, success confirms and commits stock', async () => {
    const forged = await request(app.getHttpServer())
      .post('/v1/payments/sandbox/webhook')
      .set('x-sandbox-signature', 'a'.repeat(64))
      .send({
        eventId: 'evt_forged_123',
        paymentId: orderId,
        outcome: 'succeeded',
        amountMinor: '2400',
        currency: 'GBP',
        occurredAt: new Date().toISOString(),
      });
    expect(forged.status).toBe(401);
    expect(forged.body.code).toBe('SIGNATURE_INVALID');
    const declined = await sf(NW)
      .post(`/v1/storefront/orders/${orderId}/sandbox-payment`)
      .send({ cartToken, outcome: 'failed' });
    expect(declined.body).toMatchObject({
      status: 'pending_payment',
      paymentStatus: 'failed',
      payment: { status: 'failed', sandbox: true },
    });
    const paid = await sf(NW)
      .post(`/v1/storefront/orders/${orderId}/sandbox-payment`)
      .send({ cartToken, outcome: 'succeeded' });
    expect(paid.body).toMatchObject({
      status: 'confirmed',
      paymentStatus: 'paid',
      payment: { status: 'captured' },
    });
    expect(await bal(item.variantId, nwMain)).toMatchObject({ reserved: '0.000000', committed: '2.000000' });
    expect(
      (
        await sf(NW)
          .post(`/v1/storefront/orders/${orderId}/sandbox-payment`)
          .send({ cartToken, outcome: 'succeeded' })
      ).status,
    ).toBe(409);
    const detail = (await nw.get(`/v1/admin/orders/${orderId}`)).body;
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual([
      'created',
      'payment_started',
      'payment_failed',
      'payment_started',
      'payment_captured',
      'confirmed',
    ]);
    expect(detail.payments).toHaveLength(2);
    expect(
      (
        await one<{ n: number }>(
          "select count(*)::int n from outbox_events where event_type = 'OrderConfirmed' and aggregate_id = $1",
          [orderId],
        )
      ).n,
    ).toBe(1);

    // Replayed callback for a settled payment: acknowledged, ignored the second time.
    const captured = detail.payments.find((p: { status: string }) => p.status === 'captured');
    const event = {
      eventId: `evt_${uid()}`,
      paymentId: captured.id,
      outcome: 'succeeded',
      amountMinor: '2400',
      currency: 'GBP',
      occurredAt: new Date().toISOString(),
    };
    expect((await signed(event)).body).toEqual({ received: true, duplicate: false });
    expect((await signed(event)).body).toEqual({ received: true, duplicate: true });
    expect((await signed({ ...event, eventId: `evt_${uid()}`, amountMinor: '1' })).status).toBe(422);
  });

  it('cancelling a paid order releases committed stock through the ledger and records the refund due', async () => {
    const c = await nw.post(`/v1/admin/orders/${orderId}/cancel`).send({ reason: 'Customer changed mind' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body).toMatchObject({
      status: 'cancelled',
      paymentStatus: 'refund_due',
      refundDueMinor: '2400',
      cancelReason: 'Customer changed mind',
    });
    expect(await bal(item.variantId, nwMain)).toMatchObject({ committed: '0.000000', on_hand: '5.000000' });
    const moves = await ownerPool.query(
      "select type from stock_movements where variant_id = $1 and type = 'commitment_release'",
      [item.variantId],
    );
    expect(moves.rowCount).toBe(1);
    expect(
      (await nw.post(`/v1/admin/orders/${orderId}/cancel`).send({ reason: 'Again please' })).status,
    ).toBe(409);
    expect(await auditCount(northwind, 'order.cancelled')).toBeGreaterThan(0);
    await expect(
      ownerPool.query("update orders set status = 'confirmed' where id = $1", [orderId]),
    ).rejects.toThrow(/cannot be reopened/);
  });

  it('sandbox payments are refused when disabled', async () => {
    const off = await startApp({ PAYMENTS_SANDBOX_ENABLED: false });
    try {
      const r = await request(off.getHttpServer())
        .post('/v1/payments/sandbox/webhook')
        .set('x-sandbox-signature', 'a'.repeat(64))
        .send({});
      expect(r.body.code).toBe('PAYMENTS_DISABLED');
    } finally {
      await off.close();
    }
  });
});

describe('concurrency and expiry (O-03, O-05)', () => {
  it('two shoppers race for the last unit: exactly one order, nothing else held', async () => {
    const item = await nwItem('5.00', '1');
    const [a, b] = [
      await cartWith(NW, [{ variantId: item.variantId }]),
      await cartWith(NW, [{ variantId: item.variantId }]),
    ];
    const results = await Promise.all([checkout(NW, a), checkout(NW, b)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('INSUFFICIENT_STOCK');
    expect((await bal(item.variantId, nwMain)).reserved).toBe('1.000000');
    const orders = await ownerPool.query('select count(*)::int n from order_lines where variant_id = $1', [
      item.variantId,
    ]);
    expect(orders.rows[0].n).toBe(1);
  });

  it('two shoppers race for the same jewellery piece: exactly one gets it', async () => {
    const v = (
      await one<{ id: string }>("select id from variants where tenant_id = $1 and sku = 'LUM-SOL-6'", [
        lumiere,
      ])
    ).id;
    const p18 = (
      await one<{ id: string }>("select id from purity_definitions where tenant_id = $1 and code = '18K'", [
        lumiere,
      ])
    ).id;
    const piece = await lu.post('/v1/admin/serial-items').send({
      variantId: v,
      purityId: p18,
      serialTag: `LUM-RACE-${uid()}`,
      gross: { value: '3.3', unit: 'g' },
      net: { value: '3.1', unit: 'g' },
    });
    expect(piece.status, JSON.stringify(piece.body)).toBe(201);
    await lu
      .post('/v1/admin/inventory/receipts', key())
      .send({ locationId: lumMain, lines: [{ variantId: v, serialItemIds: [piece.body.id] }] })
      .expect(201);
    const line = { variantId: v, serialItemId: piece.body.id };
    const [a, b] = [await cartWith(LUM, [line]), await cartWith(LUM, [line])];
    const results = await Promise.all([checkout(LUM, a), checkout(LUM, b)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const won = results.find((r) => r.status === 201)!.body;
    expect(
      (
        await one<{ stock_state: string }>('select stock_state from serial_items where id = $1', [
          piece.body.id,
        ])
      ).stock_state,
    ).toBe('reserved');
    const winner = results[0]!.status === 201 ? a : b;
    const paid = await sf(LUM)
      .post(`/v1/storefront/orders/${won.id}/sandbox-payment`)
      .send({ cartToken: winner.token, outcome: 'succeeded' });
    expect(paid.body.status).toBe('confirmed');
    expect(
      (
        await one<{ stock_state: string }>('select stock_state from serial_items where id = $1', [
          piece.body.id,
        ])
      ).stock_state,
    ).toBe('committed');
  });

  it('an unpaid order past its window is cancelled and released; a late capture becomes a refund due', async () => {
    const item = await nwItem('7.00', '3');
    const cart = await cartWith(NW, [{ variantId: item.variantId }]);
    const placed = (await checkout(NW, cart)).body;
    // A PSP payment is in flight when the window closes.
    const pay = await ownerPool.query(
      "insert into payments (tenant_id, order_id, provider, amount_minor, currency) values ($1, $2, 'sandbox', 700, 'GBP') returning id",
      [northwind, placed.id],
    );
    await ownerPool.query("update orders set expires_at = now() - interval '1 minute' where id = $1", [
      placed.id,
    ]);
    expect(await systemTx(worker.db, (tx) => expireOrders(tx))).toBeGreaterThanOrEqual(1);
    const after = (await nw.get(`/v1/admin/orders/${placed.id}`)).body;
    expect(after).toMatchObject({ status: 'cancelled', cancelReason: 'Payment window expired' });
    expect(after.events.at(-1).type).toBe('expired');
    expect((await bal(item.variantId, nwMain)).reserved).toBe('0.000000');
    const late = {
      eventId: `evt_${uid()}`,
      paymentId: pay.rows[0].id,
      outcome: 'succeeded',
      amountMinor: '700',
      currency: 'GBP',
      occurredAt: new Date().toISOString(),
    };
    expect((await signed(late)).status).toBe(200);
    expect((await nw.get(`/v1/admin/orders/${placed.id}`)).body).toMatchObject({
      status: 'cancelled',
      paymentStatus: 'refund_due',
      refundDueMinor: '700',
    });
  });
});

describe('immutable snapshot (O-06)', () => {
  it('a confirmed order keeps its rate and breakdown after a new rate is approved; lines cannot change', async () => {
    const v = (
      await one<{ id: string }>("select id from variants where tenant_id = $1 and sku = 'LUM-SOL-6'", [
        lumiere,
      ])
    ).id;
    const p18 = (
      await one<{ id: string }>("select id from purity_definitions where tenant_id = $1 and code = '18K'", [
        lumiere,
      ])
    ).id;
    const piece = (
      await lu.post('/v1/admin/serial-items').send({
        variantId: v,
        purityId: p18,
        serialTag: `LUM-SNAP-${uid()}`,
        gross: { value: '3.2', unit: 'g' },
        net: { value: '3.0', unit: 'g' },
      })
    ).body;
    await lu
      .post('/v1/admin/inventory/receipts', key())
      .send({ locationId: lumMain, lines: [{ variantId: v, serialItemIds: [piece.id] }] })
      .expect(201);
    const cart = await cartWith(LUM, [{ variantId: v, serialItemId: piece.id }]);
    const checkedOut = await checkout(LUM, cart);
    expect(checkedOut.status, JSON.stringify(checkedOut.body)).toBe(201);
    const placed = checkedOut.body;
    await sf(LUM)
      .post(`/v1/storefront/orders/${placed.id}/sandbox-payment`)
      .send({ cartToken: cart.token, outcome: 'succeeded' })
      .expect(200);
    const before = (await lu.get(`/v1/admin/orders/${placed.id}`)).body;
    const oldRate = before.lines[0].priceSnapshot.rate.ratePerG;

    const proposed = await lu
      .post('/v1/admin/rates')
      .send({ purityId: p18, value: '9999', unit: 'per_g', reason: 'Rate jump for snapshot test' });
    await luRates.post(`/v1/admin/rates/${proposed.body.id}/approve`).send({}).expect(200);
    const after = (await lu.get(`/v1/admin/orders/${placed.id}`)).body;
    expect(after.totalMinor).toBe(before.totalMinor);
    expect(after.lines[0].priceSnapshot.rate.ratePerG).toBe(oldRate);
    expect(after.lines[0].priceSnapshot.breakdown).toEqual(before.lines[0].priceSnapshot.breakdown);
    await expect(
      ownerPool.query('update order_lines set total_minor = 1 where order_id = $1', [placed.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      ownerPool.query('update orders set total_minor = 1 where id = $1', [placed.id]),
    ).rejects.toThrow(/immutable/);
    // Put the demo rate back so later suites price as seeded.
    const restore = await lu
      .post('/v1/admin/rates')
      .send({ purityId: p18, value: '5440', unit: 'per_g', reason: 'Restore seeded test rate' });
    await luRates.post(`/v1/admin/rates/${restore.body.id}/approve`).send({}).expect(200);
  });
});

describe('admin orders and approval (O-07)', () => {
  it('orders at or above the threshold wait for a second person; reject releases stock', async () => {
    const item = await nwItem('10.00', '10');
    const s = (await nw.get('/v1/admin/order-settings')).body;
    await nw
      .put('/v1/admin/order-settings')
      .send({ version: s.version, approvalThresholdMinor: '1500' })
      .expect(200);
    try {
      const body = { contact, lines: [{ variantId: item.variantId, quantity: 2 }] };
      expect((await nw.post('/v1/admin/orders').send(body)).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      const big = await nw.post('/v1/admin/orders', key()).send(body);
      expect(big.status, JSON.stringify(big.body)).toBe(201);
      expect(big.body).toMatchObject({
        status: 'awaiting_approval',
        paymentTerms: 'on_account',
        totalMinor: '2000',
        origin: 'admin',
      });
      expect((await bal(item.variantId, nwMain)).reserved).toBe('2.000000');
      const self = await nw.post(`/v1/admin/orders/${big.body.id}/approve`).send({});
      expect(self.body.code).toBe('SEPARATION_OF_DUTIES');
      const ok = await nwAdmin
        .post(`/v1/admin/orders/${big.body.id}/approve`)
        .send({ note: 'Credit checked' });
      expect(ok.body).toMatchObject({ status: 'confirmed', approvedBy: { id: expect.any(String) } });
      expect(await bal(item.variantId, nwMain)).toMatchObject({
        reserved: '0.000000',
        committed: '2.000000',
      });

      const second = (await nw.post('/v1/admin/orders', key()).send(body)).body;
      const rejected = await nwAdmin
        .post(`/v1/admin/orders/${second.id}/reject`)
        .send({ reason: 'Over the customer limit' });
      expect(rejected.body).toMatchObject({ status: 'cancelled', cancelReason: 'Over the customer limit' });
      expect((await bal(item.variantId, nwMain)).reserved).toBe('0.000000');

      const small = await nw
        .post('/v1/admin/orders', key())
        .send({ contact, lines: [{ variantId: item.variantId, quantity: 1 }] });
      expect(small.body.status).toBe('confirmed');
      const listed = await nw.get('/v1/admin/orders').query({ q: small.body.number });
      expect(listed.body.items.map((o: { id: string }) => o.id)).toEqual([small.body.id]);
    } finally {
      const s2 = (await nw.get('/v1/admin/order-settings')).body;
      await nw
        .put('/v1/admin/order-settings')
        .send({ version: s2.version, approvalThresholdMinor: null })
        .expect(200);
    }
  });
});

describe('quotations (O-09)', () => {
  it('send freezes the price; convert honours it after a price change; an expired quotation cannot be accepted', async () => {
    const item = await nwItem('20.00', '5');
    const validUntil = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
    const q = await nw
      .post('/v1/admin/quotations')
      .send({ contact, lines: [{ variantId: item.variantId, quantity: 2 }], validUntil });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    expect(q.body).toMatchObject({
      status: 'draft',
      number: expect.stringMatching(/^QUO-\d{6}$/),
      priceQuote: null,
    });
    const tooLong = await nw.post('/v1/admin/quotations').send({
      contact,
      lines: [{ variantId: item.variantId }],
      validUntil: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
    });
    expect(tooLong.status).toBe(400);
    const sent = await nw.post(`/v1/admin/quotations/${q.body.id}/send`).send({ version: q.body.version });
    expect(sent.body).toMatchObject({
      status: 'sent',
      totalMinor: '4000',
      priceQuote: { expiresAt: validUntil },
    });
    await nw
      .put(`/v1/admin/pricing/books/${item.book}/list-prices`)
      .send({ items: [{ variantId: item.variantId, amount: '25.00' }] })
      .expect(200);
    expect(
      (await nw.post(`/v1/admin/quotations/${q.body.id}/convert`).send({ version: sent.body.version }))
        .status,
    ).toBe(409); // not accepted yet
    const acc = await nw
      .post(`/v1/admin/quotations/${q.body.id}/accept`)
      .send({ version: sent.body.version, note: 'Accepted by email from the buyer' });
    expect(acc.body.status).toBe('accepted');
    const order = await nw
      .post(`/v1/admin/quotations/${q.body.id}/convert`)
      .send({ version: acc.body.version });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(order.body).toMatchObject({
      origin: 'quotation',
      status: 'confirmed',
      totalMinor: '4000',
      quotationId: q.body.id,
    });
    expect((await nw.get(`/v1/admin/quotations/${q.body.id}`)).body).toMatchObject({
      status: 'converted',
      orderId: order.body.id,
    });

    const late = await nw
      .post('/v1/admin/quotations')
      .send({ contact, lines: [{ variantId: item.variantId }], validUntil });
    const lateSent = (
      await nw.post(`/v1/admin/quotations/${late.body.id}/send`).send({ version: late.body.version })
    ).body;
    await ownerPool.query("update quotations set valid_until = now() - interval '1 minute' where id = $1", [
      late.body.id,
    ]);
    const refused = await nw
      .post(`/v1/admin/quotations/${late.body.id}/accept`)
      .send({ version: lateSent.version, note: 'Too late to accept' });
    expect(refused.body.code).toBe('QUOTE_EXPIRED');
    expect(await systemTx(worker.db, (tx) => expireQuotations(tx))).toBeGreaterThanOrEqual(1);
    expect((await nw.get(`/v1/admin/quotations/${late.body.id}`)).body.status).toBe('expired');
  });
});

describe('ERP order export and no double subtract (O-10)', () => {
  it('queues one export per enabled connection; an ERP snapshot after acknowledgement does not subtract the sale twice', async () => {
    // A list-priced standard product in Aurum (published rule by a second person).
    const book = (await au.get('/v1/admin/pricing/books')).body.items.find(
      (b: { name: string }) => b.name === 'Standard prices (DEMO)',
    ).id;
    const rule = await au.post('/v1/admin/pricing/rules').send({
      bookId: book,
      name: `Standard list ${uid()}`,
      priority: 7,
      conditions: { productTypes: ['standard'] },
      definition: { base: { kind: 'list_price' } },
    });
    const published = await auRates
      .post(`/v1/admin/pricing/rules/${rule.body.id}/publish`)
      .send({ versionId: rule.body.draft.id });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    const sku = `ERP-${uid()}`;
    const p = await au.post('/v1/admin/products').send({ title: `ERP item ${sku}`, variants: [{ sku }] });
    const v = p.body.variants[0].id as string;
    await au
      .put(`/v1/admin/pricing/books/${book}/list-prices`)
      .send({ items: [{ variantId: v, amount: '100' }] })
      .expect(200);
    await au
      .post('/v1/admin/inventory/receipts', key())
      .send({ locationId: aurMain, lines: [{ variantId: v, quantity: '5' }] })
      .expect(201);

    const sim = (await au.get('/v1/admin/integrations/connections')).body.items.find(
      (c: { connectorKey: string }) => c.connectorKey === 'simulator',
    );
    await au
      .patch(`/v1/admin/integrations/connections/${sim.id}`)
      .send({ version: sim.version, settings: { exportOrders: true } })
      .expect(200);
    try {
      const order = await au
        .post('/v1/admin/orders', key())
        .send({ contact, lines: [{ variantId: v, quantity: 1 }] });
      expect(order.body.status).toBe('confirmed');
      const cmds = await ownerPool.query(
        'select connection_id, status from outbound_commands where reference = $1',
        [`ORDER:${order.body.number}`],
      );
      expect(cmds.rows).toEqual([{ connection_id: sim.id, status: 'pending' }]);
      await relayOutboundCommands(worker.db, ADAPTERS as Record<string, OrderPushAdapter>, {
        backoffBaseMs: 0,
      });
      expect((await au.get(`/v1/admin/orders/${order.body.id}`)).body.exports).toEqual([
        expect.objectContaining({ reference: `ORDER:${order.body.number}`, status: 'acknowledged' }),
      ]);

      // A file connection that (for this test) also acknowledged the order, then sends its stock figure: 4.
      const file = await au
        .post('/v1/admin/integrations/connections')
        .send({ connectorKey: 'file_csv', name: `File ${uid()}`, settings: { linkExistingBySku: true } });
      expect(file.status, JSON.stringify(file.body)).toBe(201);
      await ownerPool.query(
        "insert into outbound_commands (tenant_id, connection_id, kind, reference, payload, status, acknowledged_at) values ($1, $2, 'push_order', $3, '{}'::jsonb, 'acknowledged', now())",
        [aurum, file.body.id, `ORDER:${order.body.number}`],
      );
      const header =
        'external_id,record_type,sku,title,product_type,purity,gross_wt_g,net_wt_g,stone_wt_g,huid,tag_no,location,quantity,unit,version,updated_at,deleted';
      const csvText = `${header}\nX-${sku},design,${sku},ERP item,standard,,,,,,,main-wh,4,pcs,1,,\n`;
      const job = await au
        .post(`/v1/admin/integrations/connections/${file.body.id}/jobs/file`)
        .send({ fileName: 'stock.csv', contentBase64: Buffer.from(csvText).toString('base64') });
      expect(job.status, JSON.stringify(job.body)).toBe(201);
      const done = await au
        .post(`/v1/admin/integrations/jobs/${job.body.id}/commit`)
        .send({ mode: 'atomic' });
      expect(done.body.status, JSON.stringify(done.body)).toBe('committed');
      expect(done.body.stockResult.addedBack).toBe('1.000000');
      // ERP 4 + 1 acknowledged-but-unshipped = 5 = our on hand: nothing subtracted, still 1 committed.
      expect(await bal(v, aurMain)).toMatchObject({ on_hand: '5.000000', committed: '1.000000' });
      const rec = await au.post(`/v1/admin/integrations/connections/${file.body.id}/reconcile`).send({});
      expect(rec.body.mismatches).toBe(0);
    } finally {
      const fresh = (await au.get(`/v1/admin/integrations/connections/${sim.id}`)).body;
      await au
        .patch(`/v1/admin/integrations/connections/${sim.id}`)
        .send({ version: fresh.version, settings: { exportOrders: false } })
        .expect(200);
      // Leave Aurum's rules as seeded: later suites rely on "no rule for standard products".
      await auRates
        .post(`/v1/admin/pricing/rules/${rule.body.id}/retire`)
        .send({ reason: 'Test rule no longer needed' })
        .expect(200);
    }
  });
});

describe('isolation and permissions (O-11)', () => {
  it('other tenants and roles cannot reach order data', async () => {
    const mine = (await nw.get('/v1/admin/orders').query({ limit: 1 })).body.items[0];
    expect((await lu.get(`/v1/admin/orders/${mine.id}`)).status).toBe(404);
    expect(
      (await lu.post(`/v1/admin/orders/${mine.id}/cancel`).send({ reason: 'Not mine at all' })).status,
    ).toBe(404);
    const quotation = (await nw.get('/v1/admin/quotations').query({ limit: 1 })).body.items[0];
    expect((await lu.get(`/v1/admin/quotations/${quotation.id}`)).status).toBe(404);
    expect((await nwViewer.get('/v1/admin/orders')).status).toBe(200);
    expect((await nwViewer.post('/v1/admin/orders', key()).send({ contact, lines: [] })).body.code).toBe(
      'PERMISSION_DENIED',
    );
    expect(
      (await nwViewer.post(`/v1/admin/orders/${mine.id}/cancel`).send({ reason: 'Viewer attempt' })).body
        .code,
    ).toBe('PERMISSION_DENIED');
    expect((await nwViewer.put('/v1/admin/order-settings').send({ version: 0 })).body.code).toBe(
      'PERMISSION_DENIED',
    );
    const auQuote = await sf('aurum-b2b.localhost').post('/v1/storefront/carts');
    expect(auQuote.status).toBe(201); // B2B portal carts exist; buyer accounts arrive in Phase 08
  });
});
