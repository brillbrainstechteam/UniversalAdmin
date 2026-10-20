import { createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalPayload } from '../../src/modules/orders/payments.service';
import {
  CSRF,
  createMember,
  login,
  ownerPool,
  startApp,
  tenantId,
  TEST_PASSWORD,
  type Agent,
} from '../helpers';

/** Phase 09 acceptance (C-01 … C-09): storefront customers, exact-piece checkout, fulfilment, returns, refunds. */
let app: INestApplication;
let northwind: string;
let lumiere: string;
let nwMain: string;
let lumMain: string;
let nwChannel: string;
const NW = 'northwind.localhost';
const LUM = 'lumiere.localhost';
const SANDBOX_SECRET = 'dev-only-sandbox-payment-signing-secret-0123456789';
const address = { line1: '1 Test Street', city: 'London', countryCode: 'GB' };

function scoped(agent: Agent, tenant: string) {
  return {
    get: (p: string) => agent.get(p).set('x-tenant-id', tenant),
    post: (p: string, k?: string) => {
      const r = agent.post(p).set('x-tenant-id', tenant).set(CSRF);
      return k ? r.set('idempotency-key', k) : r;
    },
    put: (p: string) => agent.put(p).set('x-tenant-id', tenant).set(CSRF),
    patch: (p: string) => agent.patch(p).set('x-tenant-id', tenant).set(CSRF),
  };
}
type Staff = ReturnType<typeof scoped>;
let nw: Staff;
let nwViewer: Staff;
let nwShipper: Staff;
let lu: Staff;

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
const bal = async (variantId: string, loc: string) =>
  (await one<{ on_hand: string; reserved: string; committed: string }>(
    "select on_hand, reserved, committed from stock_balances where variant_id = $1 and location_id = $2 and condition = 'sellable'",
    [variantId, loc],
  )) ?? { on_hand: '0', reserved: '0', committed: '0' };

/** A storefront customer with its own cookie jar on `host`. */
function shopper(host: string) {
  const agent = request.agent(app.getHttpServer());
  return {
    agent,
    get: (p: string) => agent.get(p).set('Host', host),
    post: (p: string) => agent.post(p).set('Host', host).set(CSRF),
    put: (p: string) => agent.put(p).set('Host', host).set(CSRF),
    del: (p: string) => agent.delete(p).set('Host', host).set(CSRF),
  };
}
type Shopper = ReturnType<typeof shopper>;
async function register(host: string, marketing = { email: false, sms: false, whatsapp: false }) {
  const s = shopper(host);
  const email = `c-${uid().toLowerCase()}@example.test`;
  const r = await s
    .post('/v1/storefront/account/register')
    .send({ email, password: TEST_PASSWORD, displayName: 'Test Customer', marketing });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return Object.assign(s, { email, id: r.body.customer.id as string });
}

async function nwItem(price: string, stock: string) {
  const sku = `B2C-${uid()}`;
  const p = await nw.post('/v1/admin/products').send({ title: `Retail item ${sku}`, variants: [{ sku }] });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  await nw.patch(`/v1/admin/products/${p.body.id}`).send({ version: 0, status: 'active' }).expect(200);
  await nw.put(`/v1/admin/products/${p.body.id}/publications/${nwChannel}`).expect(200);
  const variantId = p.body.variants[0].id as string;
  const book = (await nw.get('/v1/admin/pricing/books')).body.items[0].id;
  await nw
    .put(`/v1/admin/pricing/books/${book}/list-prices`)
    .send({ items: [{ variantId, amount: price }] })
    .expect(200);
  await nw
    .post('/v1/admin/inventory/receipts', key())
    .send({ locationId: nwMain, lines: [{ variantId, quantity: stock }] })
    .expect(201);
  return { variantId, sku, slug: p.body.slug as string };
}

/** Cart → checkout (as `who`, linked when signed in) → sandbox payment. */
async function paidOrder(host: string, lines: unknown[], who?: Shopper) {
  const c = await sf(host).post('/v1/storefront/carts');
  const put = await sf(host)
    .put(`/v1/storefront/carts/${c.body.cartId}/lines`)
    .set('x-cart-token', c.body.cartToken)
    .send({ lines });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  const body = {
    cartId: c.body.cartId,
    cartToken: c.body.cartToken,
    quoteId: put.body.quote.id,
    acknowledgedTotalMinor: put.body.quote.totalMinor,
    contact: { name: 'Test Customer', email: who?.agent ? 'customer@example.test' : 'guest@example.test' },
    shippingAddress: address,
  };
  const placed = await (
    who ? who.post('/v1/storefront/checkouts') : sf(host).post('/v1/storefront/checkouts')
  )
    .set('idempotency-key', key())
    .send(body);
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  const paid = await sf(host)
    .post(`/v1/storefront/orders/${placed.body.id}/sandbox-payment`)
    .send({ cartToken: c.body.cartToken, outcome: 'succeeded' });
  expect(paid.body.status, JSON.stringify(paid.body)).toBe('confirmed');
  return {
    id: placed.body.id as string,
    number: placed.body.number as string,
    totalMinor: placed.body.totalMinor as string,
  };
}

async function order(staff: Staff, id: string) {
  const r = await staff.get(`/v1/admin/orders/${id}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
async function ship(staff: Staff, orderId: string, lines: { lineNo: number; quantity: number }[]) {
  const packed = await staff.post(`/v1/admin/orders/${orderId}/shipments`).send({ lines });
  expect(packed.status, JSON.stringify(packed.body)).toBe(201);
  const s = packed.body.shipments.at(-1);
  const shipped = await staff
    .post(`/v1/admin/orders/${orderId}/shipments/${s.id}/ship`)
    .send({ version: s.version, carrier: 'Demo Courier', trackingNumber: `TRK-${uid()}` });
  expect(shipped.status, JSON.stringify(shipped.body)).toBe(200);
  return shipped.body;
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
  nwChannel = (
    await one<{ id: string }>(
      "select channel_id as id from channel_domains where hostname = 'northwind.localhost'",
      [],
    )
  ).id;
  nw = scoped(await login(app, 'owner@northwind.demo'), northwind);
  nwViewer = scoped(await login(app, (await createMember(northwind, ['viewer'])).email), northwind);
  nwShipper = scoped(
    await login(app, (await createMember(northwind, ['fulfillment_operator'])).email),
    northwind,
  );
  lu = scoped(await login(app, 'owner@lumiere.demo'), lumiere);
});
afterAll(async () => {
  await app.close();
});

describe('customer accounts (C-01, C-02, C-03)', () => {
  it('registers, signs in and out on its own storefront only; CSRF and sessions are enforced', async () => {
    const c = await register(LUM, { email: true, sms: false, whatsapp: false });
    const me = await c.get('/v1/storefront/account/me');
    expect(me.body).toMatchObject({
      customer: { email: c.email, emailVerified: false },
      preferences: { email: true, sms: false },
    });
    // Same e-mail again → taken; wrong password → generic error; CSRF header required.
    expect(
      (
        await shopper(LUM)
          .post('/v1/storefront/account/register')
          .send({ email: c.email, password: TEST_PASSWORD, displayName: 'X' })
      ).body.code,
    ).toBe('EMAIL_TAKEN');
    expect(
      (
        await shopper(LUM)
          .post('/v1/storefront/account/login')
          .send({ email: c.email, password: 'wrong-password-123' })
      ).body.code,
    ).toBe('INVALID_CREDENTIALS');
    expect(
      (
        await request(app.getHttpServer())
          .post('/v1/storefront/account/login')
          .set('Host', LUM)
          .send({ email: c.email, password: TEST_PASSWORD })
      ).body.code,
    ).toBe('CSRF_CHECK_FAILED');
    expect(
      (
        await shopper(LUM)
          .post('/v1/storefront/account/login')
          .set('Origin', 'http://evil.example')
          .send({ email: c.email, password: TEST_PASSWORD })
      ).body.code,
    ).toBe('CSRF_CHECK_FAILED');
    // The session belongs to Lumière's storefront: not valid on Northwind, not on the B2B portal, not for staff APIs.
    expect((await c.agent.get('/v1/storefront/account/me').set('Host', NW)).status).toBe(401);
    expect((await c.agent.get('/v1/storefront/account/me').set('Host', 'aurum-b2b.localhost')).status).toBe(
      404,
    );
    expect((await c.agent.get('/v1/admin/orders').set('x-tenant-id', lumiere)).status).toBe(401);
    // A staff session does not sign anyone in to the storefront.
    const staff = await login(app, 'owner@lumiere.demo');
    expect((await staff.get('/v1/storefront/account/me').set('Host', LUM)).status).toBe(401);
    // Same e-mail on another merchant is a different account.
    expect(
      (
        await shopper(NW)
          .post('/v1/storefront/account/register')
          .send({ email: c.email, password: TEST_PASSWORD, displayName: 'Y' })
      ).status,
    ).toBe(201);
    await c.post('/v1/storefront/account/logout').expect(204);
    expect((await c.get('/v1/storefront/account/me')).status).toBe(401);
    const back = await c
      .post('/v1/storefront/account/login')
      .send({ email: c.email, password: TEST_PASSWORD });
    expect(back.status).toBe(200);
  });

  it('sees only its own orders and addresses; staff see customers per tenant with permission', async () => {
    const a = await register(NW);
    const b = await register(NW);
    const item = await nwItem('5.00', '5');
    const o = await paidOrder(NW, [{ variantId: item.variantId }], a);
    expect((await a.get('/v1/storefront/account/orders')).body.items).toEqual([
      expect.objectContaining({
        id: o.id,
        lineCount: 1,
        paymentStatus: 'paid',
        fulfillmentStatus: 'unfulfilled',
      }),
    ]);
    expect((await b.get(`/v1/storefront/account/orders/${o.id}`)).status).toBe(404);
    expect((await b.get('/v1/storefront/account/orders')).body.items).toHaveLength(0);
    const saved = await a.post('/v1/storefront/account/addresses').send({ label: 'Home', address });
    expect(saved.status).toBe(201);
    const addr = saved.body.items[0];
    expect(addr.isDefault).toBe(true);
    expect(
      (
        await b
          .put(`/v1/storefront/account/addresses/${addr.id}`)
          .send({ version: addr.version, label: 'X', address })
      ).status,
    ).toBe(404);
    expect((await b.del(`/v1/storefront/account/addresses/${addr.id}`)).status).toBe(404);
    // Staff: Northwind sees A with the linked order; Lumière cannot; a viewer has no customer access.
    const detail = await nw.get(`/v1/admin/customers/${a.id}`);
    expect(detail.body).toMatchObject({ email: a.email, orderCount: 1, addresses: [{ label: 'Home' }] });
    expect(
      (await nw.get('/v1/admin/orders').query({ customerId: a.id })).body.items.map(
        (x: { id: string }) => x.id,
      ),
    ).toEqual([o.id]);
    expect((await order(nw, o.id)).customer).toMatchObject({ id: a.id });
    expect((await lu.get(`/v1/admin/customers/${a.id}`)).status).toBe(404);
    expect((await nwViewer.get('/v1/admin/customers')).status).toBe(403);
    // Disabling ends the customer's sessions.
    const bVersion = (await nw.get(`/v1/admin/customers/${b.id}`)).body.version;
    await nw
      .put(`/v1/admin/customers/${b.id}/status`)
      .send({ version: bVersion, status: 'disabled', reason: 'Fraud check' })
      .expect(200);
    expect((await b.get('/v1/storefront/account/me')).status).toBe(401);
    // A guest checkout is never linked, even with the same e-mail.
    const guest = await paidOrder(NW, [{ variantId: item.variantId }]);
    expect((await order(nw, guest.id)).customer).toBeNull();
  });

  it('keeps an append-only consent log; the preference is the latest event', async () => {
    const c = await register(NW, { email: false, sms: true, whatsapp: false });
    await c.put('/v1/storefront/account/preferences').send({ email: true, sms: false }).expect(200);
    await c.put('/v1/storefront/account/preferences').send({ email: true }).expect(200); // no change → no event
    expect((await c.get('/v1/storefront/account/me')).body.preferences).toEqual({
      email: true,
      sms: false,
      whatsapp: false,
    });
    const history = (await nw.get(`/v1/admin/customers/${c.id}`)).body.consentHistory;
    expect(
      history.map(
        (h: { channel: string; granted: boolean; source: string }) => `${h.source}:${h.channel}:${h.granted}`,
      ),
    ).toEqual([
      'account:sms:false',
      'account:email:true',
      'registration:whatsapp:false',
      'registration:sms:true',
      'registration:email:false',
    ]);
    await expect(
      ownerPool.query('update consent_events set granted = true where customer_id = $1', [c.id]),
    ).rejects.toThrow();
    await expect(
      ownerPool.query('delete from consent_events where customer_id = $1', [c.id]),
    ).rejects.toThrow();
  });
});

describe('exact pieces, shipments and cancellation (C-04, C-05, C-06)', () => {
  it('a customer buys one exact piece; it is reserved, then ships as that piece', async () => {
    const v = (await one<{ id: string; slug: string }>(
      "select v.id, p.slug from variants v join products p on p.id = v.product_id where v.tenant_id = $1 and v.sku = 'LUM-SOL-6'",
      [lumiere],
    ))!;
    const p18 = (
      await one<{ id: string }>("select id from purity_definitions where tenant_id = $1 and code = '18K'", [
        lumiere,
      ])
    ).id;
    const tag = `LUM-B2C-${uid()}`;
    const piece = await lu.post('/v1/admin/serial-items').send({
      variantId: v.id,
      purityId: p18,
      serialTag: tag,
      gross: { value: '3.42', unit: 'g' },
      net: { value: '3.20', unit: 'g' },
    });
    expect(piece.status, JSON.stringify(piece.body)).toBe(201);
    await lu
      .post('/v1/admin/inventory/receipts', key())
      .send({ locationId: lumMain, lines: [{ variantId: v.id, serialItemIds: [piece.body.id] }] })
      .expect(201);
    const listed = await sf(LUM).get(`/v1/storefront/catalog/products/${v.slug}/pieces`);
    expect(listed.body.items.find((x: { tag: string }) => x.tag === tag)).toMatchObject({
      id: piece.body.id,
      grossG: '3.420000',
      netG: '3.200000',
    });
    const c = await register(LUM);
    const o = await paidOrder(LUM, [{ variantId: v.id, serialItemId: piece.body.id }], c);
    const state = async () =>
      (
        await one<{ stock_state: string }>('select stock_state from serial_items where id = $1', [
          piece.body.id,
        ])
      ).stock_state;
    expect(await state()).toBe('committed');
    // No longer offered, and a second order for it fails.
    expect(
      (await sf(LUM).get(`/v1/storefront/catalog/products/${v.slug}/pieces`)).body.items.some(
        (x: { tag: string }) => x.tag === tag,
      ),
    ).toBe(false);
    const c2 = await sf(LUM).post('/v1/storefront/carts');
    const put = await sf(LUM)
      .put(`/v1/storefront/carts/${c2.body.cartId}/lines`)
      .set('x-cart-token', c2.body.cartToken)
      .send({ lines: [{ variantId: v.id, serialItemId: piece.body.id }] });
    const again = await sf(LUM)
      .post('/v1/storefront/checkouts')
      .set('idempotency-key', key())
      .send({
        cartId: c2.body.cartId,
        cartToken: c2.body.cartToken,
        quoteId: put.body.quote?.id ?? randomUUID(),
        acknowledgedTotalMinor: put.body.quote?.totalMinor ?? '1',
        contact: { name: 'X', email: 'x@example.test' },
        shippingAddress: address,
      });
    expect(again.status).toBeGreaterThanOrEqual(400);
    const shipped = await ship(lu, o.id, [{ lineNo: 1, quantity: 1 }]);
    expect(shipped.fulfillmentStatus).toBe('fulfilled');
    expect(await state()).toBe('shipped');
    const mv = await one<{ type: string; on_hand_delta: string; committed_delta: string }>(
      "select type, on_hand_delta, committed_delta from stock_movements where serial_item_id = $1 and type = 'shipment'",
      [piece.body.id],
    );
    expect(mv).toMatchObject({ on_hand_delta: '-1.000000', committed_delta: '-1.000000' });
    // The customer sees the shipment with a manual (untracked) carrier note.
    const mine = (await c.get(`/v1/storefront/account/orders/${o.id}`)).body;
    expect(mine).toMatchObject({
      fulfillmentStatus: 'fulfilled',
      shipments: [{ status: 'shipped', carrier: 'Demo Courier', trackingManual: true }],
    });
  });

  it('partial shipment moves exactly the shipped quantity; packed shipments can be cancelled', async () => {
    const item = await nwItem('7.00', '5');
    const o = await paidOrder(NW, [{ variantId: item.variantId, quantity: 3 }]);
    expect(await bal(item.variantId, nwMain)).toMatchObject({ on_hand: '5.000000', committed: '3.000000' });
    // Fulfilment operator packs 1, unpacks it (no stock effect), then ships 2.
    const packed = await nwShipper
      .post(`/v1/admin/orders/${o.id}/shipments`)
      .send({ lines: [{ lineNo: 1, quantity: 1 }] });
    expect(packed.body.lines[0]).toMatchObject({ shippableQuantity: 2 });
    const s1 = packed.body.shipments[0];
    await nwShipper
      .post(`/v1/admin/orders/${o.id}/shipments/${s1.id}/cancel`)
      .send({ version: s1.version })
      .expect(200);
    expect(await bal(item.variantId, nwMain)).toMatchObject({ on_hand: '5.000000', committed: '3.000000' });
    expect(
      (
        await nwShipper
          .post(`/v1/admin/orders/${o.id}/shipments`)
          .send({ lines: [{ lineNo: 1, quantity: 4 }] })
      ).body.code,
    ).toBe('INSUFFICIENT_STOCK');
    const after = await ship(nwShipper, o.id, [{ lineNo: 1, quantity: 2 }]);
    expect(after.fulfillmentStatus).toBe('partial');
    expect(after.lines[0]).toMatchObject({ shippedQuantity: 2, shippableQuantity: 1 });
    expect(await bal(item.variantId, nwMain)).toMatchObject({ on_hand: '3.000000', committed: '1.000000' });
    const done = await ship(nwShipper, o.id, [{ lineNo: 1, quantity: 1 }]);
    expect(done.fulfillmentStatus).toBe('fulfilled');
    expect(await bal(item.variantId, nwMain)).toMatchObject({ on_hand: '2.000000', committed: '0.000000' });
    const s = done.shipments.find((x: { status: string }) => x.status === 'shipped');
    const delivered = await nwShipper
      .post(`/v1/admin/orders/${o.id}/shipments/${s.id}/deliver`)
      .send({ version: s.version });
    expect(delivered.body.shipments.some((x: { status: string }) => x.status === 'delivered')).toBe(true);
    // Viewers cannot ship.
    expect(
      (
        await nwViewer
          .post(`/v1/admin/orders/${o.id}/shipments`)
          .send({ lines: [{ lineNo: 1, quantity: 1 }] })
      ).status,
    ).toBe(403);
    // Ledger and balances agree.
    const rec = await one<{ n: number }>(
      "select count(*)::int as n from reconciliation_issues where tenant_id = $1 and variant_id = $2 and status = 'open'",
      [northwind, item.variantId],
    );
    expect(rec.n).toBe(0);
  });

  it('after a partial shipment the order cannot be cancelled; unshipped items are released with an exact refund due', async () => {
    const item = await nwItem('7.00', '3');
    const o = await paidOrder(NW, [{ variantId: item.variantId, quantity: 3 }]);
    await ship(nw, o.id, [{ lineNo: 1, quantity: 1 }]);
    const cancel = await nw.post(`/v1/admin/orders/${o.id}/cancel`).send({ reason: 'Customer changed mind' });
    expect(cancel.body.code).toBe('ORDER_SHIPPED');
    const rest = await nw
      .post(`/v1/admin/orders/${o.id}/cancel-remaining`)
      .send({ reason: 'Customer changed mind' });
    expect(rest.status, JSON.stringify(rest.body)).toBe(200);
    expect(rest.body).toMatchObject({
      status: 'confirmed',
      fulfillmentStatus: 'fulfilled',
      paymentStatus: 'refund_due',
      refundDueMinor: '1400',
    });
    expect(await bal(item.variantId, nwMain)).toMatchObject({ on_hand: '2.000000', committed: '0.000000' });
    expect(
      (await nw.post(`/v1/admin/orders/${o.id}/cancel-remaining`).send({ reason: 'again' })).status,
    ).toBe(409);
    // Refund the due amount through the gateway: due drops to zero, payment partially refunded.
    const refund = await nw
      .post(`/v1/admin/orders/${o.id}/refunds`, key())
      .send({ amountMinor: '1400', reason: 'Unshipped items' });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    expect(refund.body).toMatchObject({
      refundDueMinor: '0',
      paymentStatus: 'partially_refunded',
      refunds: [{ status: 'succeeded', amountMinor: '1400' }],
    });
  });
});

describe('returns and refunds (C-07, C-08, C-09)', () => {
  it('a customer returns shipped items in the window; staff approve and restock; outside the window is refused', async () => {
    const item = await nwItem('4.00', '4');
    const c = await register(NW);
    const o = await paidOrder(NW, [{ variantId: item.variantId, quantity: 2 }], c);
    // Nothing shipped yet → no return.
    expect(
      (
        await c
          .post(`/v1/storefront/account/orders/${o.id}/returns`)
          .send({ lines: [{ lineNo: 1, quantity: 1 }], reason: 'Too big' })
      ).status,
    ).toBe(409);
    await ship(nw, o.id, [{ lineNo: 1, quantity: 2 }]);
    expect(await bal(item.variantId, nwMain)).toMatchObject({ on_hand: '2.000000' });
    expect(
      (
        await c
          .post(`/v1/storefront/account/orders/${o.id}/returns`)
          .send({ lines: [{ lineNo: 1, quantity: 3 }], reason: 'Too big' })
      ).status,
    ).toBe(422);
    const req = await c
      .post(`/v1/storefront/account/orders/${o.id}/returns`)
      .send({ lines: [{ lineNo: 1, quantity: 1 }], reason: 'Too big' });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    expect(req.body.returns[0]).toMatchObject({ status: 'requested', valueMinor: '400' });
    expect(req.body.lines[0].returnableQuantity).toBe(1);
    const list = await nw.get('/v1/admin/returns').query({ status: 'requested' });
    const ret = list.body.items.find((r: { orderId: string }) => r.orderId === o.id);
    expect(ret).toMatchObject({ requestedBy: 'customer', lines: [{ quantity: 1 }] });
    expect(
      (
        await nw
          .post(`/v1/admin/returns/${ret.id}/receive`)
          .send({ version: ret.version, restock: true, locationId: nwMain })
      ).status,
    ).toBe(409);
    expect(
      (await nw.post(`/v1/admin/returns/${ret.id}/decide`).send({ version: ret.version, approve: false }))
        .status,
    ).toBe(400); // reason needed
    const ok = await nw
      .post(`/v1/admin/returns/${ret.id}/decide`)
      .send({ version: ret.version, approve: true, note: 'Within policy' });
    expect(ok.body.status).toBe('approved');
    const recv = await nw
      .post(`/v1/admin/returns/${ret.id}/receive`)
      .send({ version: ok.body.version, restock: true, locationId: nwMain });
    expect(recv.body).toMatchObject({ status: 'received', restocked: true });
    expect(await bal(item.variantId, nwMain)).toMatchObject({ on_hand: '3.000000' });
    expect(
      (
        await one<{ n: number }>(
          "select count(*)::int as n from stock_movements where reference = $1 and type = 'return_receive'",
          [ret.number],
        )
      ).n,
    ).toBe(1);
    const refund = await nw
      .post(`/v1/admin/orders/${o.id}/refunds`, key())
      .send({ amountMinor: '400', reason: 'Return received', returnId: ret.id });
    expect(refund.body).toMatchObject({ paymentStatus: 'partially_refunded' });
    // Return window: with 0 days, the window has closed.
    const s = (await nw.get('/v1/admin/order-settings')).body;
    await nw.put('/v1/admin/order-settings').send({ version: s.version, returnWindowDays: 0 }).expect(200);
    try {
      expect(
        (
          await c
            .post(`/v1/storefront/account/orders/${o.id}/returns`)
            .send({ lines: [{ lineNo: 1, quantity: 1 }], reason: 'Late' })
        ).body.code,
      ).toBe('RETURN_WINDOW_CLOSED');
    } finally {
      const s2 = (await nw.get('/v1/admin/order-settings')).body;
      await nw
        .put('/v1/admin/order-settings')
        .send({ version: s2.version, returnWindowDays: 14 })
        .expect(200);
    }
  });

  it('a returned piece that is not restocked is written off', async () => {
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
      serialTag: `LUM-RET-${uid()}`,
      gross: { value: '3.1', unit: 'g' },
      net: { value: '3.0', unit: 'g' },
    });
    await lu
      .post('/v1/admin/inventory/receipts', key())
      .send({ locationId: lumMain, lines: [{ variantId: v, serialItemIds: [piece.body.id] }] })
      .expect(201);
    const o = await paidOrder(LUM, [{ variantId: v, serialItemId: piece.body.id }]);
    await ship(lu, o.id, [{ lineNo: 1, quantity: 1 }]);
    const ret = await lu
      .post(`/v1/admin/orders/${o.id}/returns`)
      .send({ lines: [{ lineNo: 1, quantity: 1 }], reason: 'Damaged in transit' });
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);
    const ok = await lu
      .post(`/v1/admin/returns/${ret.body.id}/decide`)
      .send({ version: ret.body.version, approve: true });
    await lu
      .post(`/v1/admin/returns/${ret.body.id}/receive`)
      .send({ version: ok.body.version, restock: false, locationId: lumMain })
      .expect(200);
    expect(
      await one<{ stock_state: string; location_id: string | null }>(
        'select stock_state, location_id from serial_items where id = $1',
        [piece.body.id],
      ),
    ).toMatchObject({
      stock_state: 'written_off',
      location_id: null,
    });
  });

  it('refunds never exceed what was captured, even concurrently; only signed callbacks settle them', async () => {
    const item = await nwItem('10.00', '2');
    const o = await paidOrder(NW, [{ variantId: item.variantId }]); // captured 1000
    expect(
      (
        await nw
          .post(`/v1/admin/orders/${o.id}/refunds`, key())
          .send({ amountMinor: '1001', reason: 'Too much' })
      ).body.code,
    ).toBe('REFUND_EXCEEDS_CAPTURED');
    expect(
      (await nw.post(`/v1/admin/orders/${o.id}/refunds`).send({ amountMinor: '100', reason: 'No key' }))
        .status,
    ).toBe(400);
    expect(
      (
        await nwViewer
          .post(`/v1/admin/orders/${o.id}/refunds`, key())
          .send({ amountMinor: '100', reason: 'Viewer' })
      ).status,
    ).toBe(403);
    // A declined refund frees its amount again.
    const failed = await nw
      .post(`/v1/admin/orders/${o.id}/refunds`, key())
      .send({ amountMinor: '600', reason: 'Declined', sandboxOutcome: 'failed' });
    expect(failed.body.refunds[0]).toMatchObject({ status: 'failed' });
    expect(failed.body.payments[0].refundedMinor).toBe('0');
    // Two concurrent 600 refunds on 1000 captured: exactly one succeeds.
    const [r1, r2] = await Promise.all([
      nw.post(`/v1/admin/orders/${o.id}/refunds`, key()).send({ amountMinor: '600', reason: 'Race A' }),
      nw.post(`/v1/admin/orders/${o.id}/refunds`, key()).send({ amountMinor: '600', reason: 'Race B' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const after = await order(nw, o.id);
    expect(after.payments[0].refundedMinor).toBe('600');
    expect(after.paymentStatus).toBe('partially_refunded');
    const rest = await nw
      .post(`/v1/admin/orders/${o.id}/refunds`, key())
      .send({ amountMinor: '400', reason: 'Rest' });
    expect(rest.body.paymentStatus).toBe('refunded');
    expect(
      (await ownerPool
        .query('update payments set refunded_minor = amount_minor + 1 where order_id = $1', [o.id])
        .catch((e: Error) => e)) instanceof Error,
    ).toBe(true);
    // Forged or replayed refund callbacks do nothing.
    const done = after.refunds.find((r: { status: string }) => r.status === 'succeeded');
    const event = {
      eventId: `evt_${uid()}`,
      paymentId: done.paymentId,
      refundId: done.id,
      outcome: 'failed',
      amountMinor: done.amountMinor,
      currency: 'GBP',
      occurredAt: new Date().toISOString(),
    };
    expect(
      (
        await request(app.getHttpServer())
          .post('/v1/payments/sandbox/webhook')
          .set('x-sandbox-signature', '0'.repeat(64))
          .send(event)
      ).status,
    ).toBe(401);
    await signed(event).expect(200);
    expect((await signed(event)).body).toEqual({ received: true, duplicate: true });
    expect(
      (await order(nw, o.id)).refunds.filter((r: { status: string }) => r.status === 'succeeded'),
    ).toHaveLength(2);
    // An unpaid order has nothing to refund.
    const unpaid = await nw.post('/v1/admin/orders', key()).send({
      contact: { name: 'Shop', email: 'shop@example.test' },
      lines: [{ variantId: item.variantId }],
    });
    expect(
      (
        await nw
          .post(`/v1/admin/orders/${unpaid.body.id}/refunds`, key())
          .send({ amountMinor: '1', reason: 'None' })
      ).body.code,
    ).toBe('REFUND_EXCEEDS_CAPTURED');
  });

  it('customer messages are recorded, never claimed as delivered', async () => {
    const item = await nwItem('3.00', '1');
    const c = await register(NW);
    const o = await paidOrder(NW, [{ variantId: item.variantId }], c);
    await ship(nw, o.id, [{ lineNo: 1, quantity: 1 }]);
    const detail = await order(nw, o.id);
    expect(detail.messages.map((m: { template: string }) => m.template)).toEqual([
      'order_confirmed',
      'order_shipped',
    ]);
    expect(
      detail.messages.every(
        (m: { status: string; statusReason: string }) =>
          m.status === 'not_sent' && /not delivered/.test(m.statusReason),
      ),
    ).toBe(true);
    expect(
      (await c.get(`/v1/storefront/account/orders/${o.id}`)).body.messages.every(
        (m: { status: string }) => m.status === 'not_sent',
      ),
    ).toBe(true);
  });
});
