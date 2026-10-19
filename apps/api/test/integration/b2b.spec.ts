import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CSRF,
  createMember,
  locationId,
  login,
  ownerPool,
  startApp,
  tenantId,
  TEST_PASSWORD,
  type Agent,
} from '../helpers';

/** Phase 08 acceptance (B-01 … B-10). Seeded: Shree Jewels (DEMO) with buyer (Mumbai only, limit ₹1,00,000) and approver. */
let app: INestApplication;
let aurum: string;
let lumiere: string;
let aurMain: string;
let b2bChannel: string;
let shree: string;
let shreeBook: string;
let mumbai: string;
let pune: string;
const PORTAL = 'aurum-b2b.localhost';

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
type Staff = ReturnType<typeof scoped>;
let au: Staff;
let auRates: Staff;
let rep: Staff;
let repUserId: string;
let lu: Staff;

/** A signed-in buyer on a portal domain (cookie jar per agent). */
function portal(host = PORTAL) {
  const agent = request.agent(app.getHttpServer());
  return {
    agent,
    get: (p: string) => agent.get(p).set('Host', host),
    post: (p: string) => agent.post(p).set('Host', host).set(CSRF),
  };
}
type Buyer = ReturnType<typeof portal>;
async function buyerLogin(email: string, host = PORTAL): Promise<Buyer> {
  const b = portal(host);
  const r = await b.post('/v1/storefront/b2b/auth/login').send({ email, password: TEST_PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return b;
}
let buyer: Buyer;
let approver: Buyer;

let seq = 0;
const uid = () => `${Date.now().toString(36)}${++seq}`.toUpperCase();
const key = () => `key-${uid()}-${Math.random().toString(36).slice(2, 8)}`;
const one = async <T = Record<string, unknown>>(q: string, params: unknown[]) =>
  (await ownerPool.query(q, params)).rows[0] as T;

/** A list-priced standard product, published on the B2B portal, priced in Shree's contract book, with stock. */
async function wholesaleItem(price: string, stock: string, moq: number | null = null) {
  const sku = `WH-${uid()}`;
  const p = await au.post('/v1/admin/products').send({ title: `Wholesale ${sku}`, variants: [{ sku }] });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  await au.patch(`/v1/admin/products/${p.body.id}`).send({ version: 0, status: 'active' }).expect(200);
  await au.put(`/v1/admin/products/${p.body.id}/publications/${b2bChannel}`).expect(200);
  const variantId = p.body.variants[0].id as string;
  await au
    .put(`/v1/admin/pricing/books/${shreeBook}/list-prices`)
    .send({ items: [{ variantId, amount: price, minQuantity: moq }] })
    .expect(200);
  await au
    .post('/v1/admin/inventory/receipts', key())
    .send({ locationId: aurMain, lines: [{ variantId, quantity: stock }] })
    .expect(201);
  return { sku, variantId, productId: p.body.id as string };
}
async function priceAndOrder(
  b: Buyer,
  lines: unknown[],
  location = mumbai,
  extra: Record<string, unknown> = {},
) {
  const priced = await b.post('/v1/storefront/b2b/price').send({ lines });
  expect(priced.status, JSON.stringify(priced.body)).toBe(200);
  const placed = await b.post('/v1/storefront/b2b/orders').send({
    quoteId: priced.body.quoteId,
    acknowledgedTotalMinor: priced.body.totalMinor,
    locationId: location,
    ...extra,
  });
  return { priced: priced.body, placed };
}
async function company() {
  return (await au.get(`/v1/admin/companies/${shree}`)).body;
}
async function patchCompany(body: Record<string, unknown>) {
  const c = await company();
  const r = await au.patch(`/v1/admin/companies/${shree}`).send({ version: c.version, ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

beforeAll(async () => {
  app = await startApp();
  aurum = await tenantId('aurum-wholesale');
  lumiere = await tenantId('lumiere-fine');
  aurMain = await locationId('aurum-wholesale', 'main-wh');
  b2bChannel = (
    await one<{ id: string }>("select id from channels where tenant_id = $1 and code = 'b2b-web'", [aurum])
  ).id;
  const c = await one<{ id: string; price_book_id: string }>(
    "select id, price_book_id from companies where code = 'SHREE'",
    [],
  );
  shree = c.id;
  shreeBook = c.price_book_id;
  mumbai = (
    await one<{ id: string }>(
      "select id from company_locations where company_id = $1 and code = 'mumbai-ho'",
      [shree],
    )
  ).id;
  pune = (
    await one<{ id: string }>(
      "select id from company_locations where company_id = $1 and code = 'pune-store'",
      [shree],
    )
  ).id;
  au = scoped(await login(app, 'owner@aurum.demo'), aurum);
  auRates = scoped(await login(app, 'rates@aurum.demo'), aurum);
  const repMember = await createMember(aurum, ['sales_rep']);
  repUserId = repMember.userId;
  rep = scoped(await login(app, repMember.email, 'merchant', TEST_PASSWORD), aurum);
  lu = scoped(await login(app, 'owner@lumiere.demo'), lumiere);
  // Shree's contract book also prices standard products from list prices (published by a second person).
  const rule = await au.post('/v1/admin/pricing/rules').send({
    bookId: shreeBook,
    name: 'Wholesale list prices',
    priority: 5,
    conditions: { productTypes: ['standard'] },
    definition: { base: { kind: 'list_price' } },
  });
  await auRates
    .post(`/v1/admin/pricing/rules/${rule.body.id}/publish`)
    .send({ versionId: rule.body.draft.id })
    .expect(200);
  buyer = await buyerLogin('buyer@shree.demo');
  approver = await buyerLogin('approver@shree.demo');
});
afterAll(async () => {
  await app.close();
});

describe('buyer identity and sessions (B-01)', () => {
  it('is separate from staff sessions, bound to the B2B portal and protected against CSRF', async () => {
    const me = await buyer.get('/v1/storefront/b2b/me');
    expect(me.body).toMatchObject({
      user: { email: 'buyer@shree.demo' },
      company: { name: 'Shree Jewels Pvt Ltd (DEMO)', role: 'buyer' },
    });
    expect(me.body.company.locations.map((l: { code: string }) => l.code)).toEqual(['mumbai-ho']); // location-scoped buyer
    const noCsrf = await request(app.getHttpServer())
      .post('/v1/storefront/b2b/auth/login')
      .set('Host', PORTAL)
      .send({ email: 'buyer@shree.demo', password: TEST_PASSWORD });
    expect(noCsrf.body.code).toBe('CSRF_CHECK_FAILED');
    const foreignOrigin = await request(app.getHttpServer())
      .post('/v1/storefront/b2b/auth/login')
      .set('Host', PORTAL)
      .set(CSRF)
      .set('Origin', 'https://evil.example')
      .send({ email: 'buyer@shree.demo', password: TEST_PASSWORD });
    expect(foreignOrigin.body.code).toBe('CSRF_CHECK_FAILED');
    const b2c = await request(app.getHttpServer())
      .post('/v1/storefront/b2b/auth/login')
      .set('Host', 'lumiere.localhost')
      .set(CSRF)
      .send({ email: 'buyer@shree.demo', password: TEST_PASSWORD });
    expect(b2c.status).toBe(404);
    const staffAsBuyer = await request(app.getHttpServer())
      .post('/v1/storefront/b2b/auth/login')
      .set('Host', PORTAL)
      .set(CSRF)
      .send({ email: 'owner@aurum.demo', password: TEST_PASSWORD });
    expect(staffAsBuyer.status).toBe(403);
    expect((await buyer.agent.get('/v1/admin/companies').set('x-tenant-id', aurum)).status).toBe(401);
    expect(
      (
        await request(app.getHttpServer())
          .post('/v1/auth/login')
          .set(CSRF)
          .send({ email: 'buyer@shree.demo', password: TEST_PASSWORD, audience: 'buyer' })
      ).status,
    ).toBe(400);
    const b = await buyerLogin('buyer@shree.demo');
    await b.post('/v1/storefront/b2b/auth/logout').expect(204);
    expect((await b.get('/v1/storefront/b2b/me')).status).toBe(401);
  });
});

describe('company pricing and catalog (B-03, B-04)', () => {
  it("prices jewellery with the company's contract book", async () => {
    const r = await buyer
      .post('/v1/storefront/b2b/price')
      .send({ lines: [{ sku: 'AUR-BAND22-14', serialTag: 'AUR-T-0001', quantity: 1 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // contract making 350/g on 4.612 g (public rule charges 450/g)
    expect(r.body.lines[0].components).toContainEqual({
      label: 'Making charge per gram (net)',
      amountMinor: '161420',
    });
    const staffView = await au.post('/v1/admin/pricing/quotes').send({
      lines: [
        {
          variantId: (
            await one<{ variant_id: string }>(
              "select variant_id from serial_items where serial_tag = 'AUR-T-0001'",
              [],
            )
          ).variant_id,
          serialItemId: (
            await one<{ id: string }>("select id from serial_items where serial_tag = 'AUR-T-0001'", [])
          ).id,
        },
      ],
    });
    expect(staffView.body.lines[0].rule.name).not.toMatch(/contract/); // the company book is never used for anyone else
  });

  it('enforces MOQ, minimum order value and the company catalog restriction', async () => {
    const item = await wholesaleItem('2000.00', '50', 5);
    const small = await buyer
      .post('/v1/storefront/b2b/price')
      .send({ lines: [{ sku: item.sku, quantity: 2 }] });
    expect(small.body.problems.map((p: { code: string }) => p.code)).toEqual([
      'MINIMUM_NOT_MET',
      'MINIMUM_NOT_MET',
    ]); // MOQ 5 and ₹10,000 minimum
    const refused = await buyer.post('/v1/storefront/b2b/orders').send({
      quoteId: small.body.quoteId,
      acknowledgedTotalMinor: small.body.totalMinor,
      locationId: mumbai,
    });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('MINIMUM_NOT_MET');
    const listed = await buyer.get('/v1/storefront/b2b/catalog').query({ q: item.sku });
    expect(listed.body.items[0].variants[0]).toMatchObject({ sku: item.sku, moq: 5 });

    const col = await au.post('/v1/admin/collections').send({ title: `Shree only ${uid()}` });
    expect(col.status, JSON.stringify(col.body)).toBe(201);
    await patchCompany({ catalogMode: 'collections', collectionIds: [col.body.id] });
    try {
      expect((await buyer.get('/v1/storefront/b2b/catalog').query({ q: item.sku })).body.items).toHaveLength(
        0,
      );
      const hidden = await buyer
        .post('/v1/storefront/b2b/price')
        .send({ lines: [{ sku: item.sku, quantity: 5 }] });
      expect(hidden.status).toBe(422);
      expect(hidden.body.details.problems[0].code).toBe('NOT_FOUND');
    } finally {
      await patchCompany({ catalogMode: 'all', collectionIds: [] });
    }
  });
});

describe('ordering, credit and approvals (B-02, B-05, B-06)', () => {
  it('places an on-account order within credit; location scope is enforced', async () => {
    const item = await wholesaleItem('2000.00', '50');
    const before = (await company()).credit.exposureMinor;
    const { placed } = await priceAndOrder(buyer, [{ sku: item.sku, quantity: 5 }], mumbai, {
      poNumber: 'PO-7781',
    });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect(placed.body).toMatchObject({
      status: 'confirmed',
      totalMinor: '1000000',
      poNumber: 'PO-7781',
      location: { name: 'Mumbai head office' },
    });
    expect(BigInt((await company()).credit.exposureMinor) - BigInt(before)).toBe(1_000_000n);
    const elsewhere = await priceAndOrder(buyer, [{ sku: item.sku, quantity: 5 }], pune);
    expect(elsewhere.placed.status).toBe(400); // buyer is limited to Mumbai
    // The approver (all locations) sees the order; staff see it with company fields.
    expect((await approver.get(`/v1/storefront/b2b/orders/${placed.body.id}`)).status).toBe(200);
    expect((await au.get(`/v1/admin/orders/${placed.body.id}`)).body.contact.name).toMatch(/Shree/);
  });

  it('refuses orders over the credit limit or while on hold; payments and cancellations move exposure', async () => {
    const item = await wholesaleItem('5000.00', '100');
    const c = await company();
    await patchCompany({ creditLimitMinor: (BigInt(c.credit.exposureMinor) + 1_000_000n).toString() });
    try {
      const over = await priceAndOrder(buyer, [{ sku: item.sku, quantity: 3 }]); // ₹15,000 > ₹10,000 available
      expect(over.placed.status).toBe(409);
      expect(over.placed.body).toMatchObject({
        code: 'CREDIT_LIMIT_EXCEEDED',
        details: { availableMinor: '1000000' },
      });
      const pay = await au.post(`/v1/admin/companies/${shree}/credit`).send({
        type: 'payment',
        amountMinor: '1000000',
        reference: 'NEFT-123',
        note: 'Payment received by bank transfer',
      });
      expect(pay.status, JSON.stringify(pay.body)).toBe(201);
      expect(pay.body.credit.availableMinor).toBe('2000000');
      const ok = await priceAndOrder(buyer, [{ sku: item.sku, quantity: 3 }]);
      expect(ok.placed.status).toBe(201);
      const exposureBefore = BigInt((await company()).credit.exposureMinor);
      await au
        .post(`/v1/admin/orders/${ok.placed.body.id}/cancel`)
        .send({ reason: 'Buyer called to cancel' })
        .expect(200);
      expect(BigInt((await company()).credit.exposureMinor)).toBe(exposureBefore - 1_500_000n);
      const ledger = (await au.get(`/v1/admin/companies/${shree}/credit`)).body.items.map(
        (e: { type: string }) => e.type,
      );
      expect(ledger.slice(0, 3)).toEqual(['order_release', 'order_charge', 'payment']);
      await expect(
        ownerPool.query('update credit_entries set amount_minor = 1 where company_id = $1', [shree]),
      ).rejects.toThrow();

      await patchCompany({ status: 'on_hold' });
      const held = await priceAndOrder(buyer, [{ sku: item.sku, quantity: 2 }]);
      expect(held.placed.body.code).toBe('COMPANY_ON_HOLD');
    } finally {
      await patchCompany({ status: 'active', creditLimitMinor: '50000000' });
    }
  });

  it("orders over a buyer's limit wait for a company approver, who cannot approve their own", async () => {
    const item = await wholesaleItem('30000.00', '20'); // 4 × ₹30,000 = ₹1,20,000 > buyer limit ₹1,00,000
    await au
      .post(`/v1/admin/companies/${shree}/credit`)
      .send({
        type: 'advance',
        amountMinor: '20000000',
        reference: 'ADV-1',
        note: 'Advance for large orders',
      })
      .expect(201);
    const { placed } = await priceAndOrder(buyer, [{ sku: item.sku, quantity: 4 }]);
    expect(placed.body.status).toBe('awaiting_buyer_approval');
    expect((await buyer.post(`/v1/storefront/b2b/orders/${placed.body.id}/approve`).send({})).body.code).toBe(
      'PERMISSION_DENIED',
    );
    const ok = await approver
      .post(`/v1/storefront/b2b/orders/${placed.body.id}/approve`)
      .send({ note: 'Within budget' });
    expect(ok.body).toMatchObject({ status: 'confirmed', approvalNote: 'Within budget' });

    // Company approval does not bypass the merchant's own approval threshold.
    const s = (await au.get('/v1/admin/order-settings')).body;
    await au
      .put('/v1/admin/order-settings')
      .send({ version: s.version, approvalThresholdMinor: '10000000' })
      .expect(200);
    try {
      const big = await priceAndOrder(buyer, [{ sku: item.sku, quantity: 4 }]);
      expect(big.placed.body.status).toBe('awaiting_buyer_approval');
      const companyOk = await approver
        .post(`/v1/storefront/b2b/orders/${big.placed.body.id}/approve`)
        .send({});
      expect(companyOk.body.status).toBe('awaiting_approval');
      const staffOk = await au
        .post(`/v1/admin/orders/${big.placed.body.id}/approve`)
        .send({ note: 'Checked' });
      expect(staffOk.body.status, JSON.stringify(staffOk.body)).toBe('confirmed');
    } finally {
      const s2 = (await au.get('/v1/admin/order-settings')).body;
      await au
        .put('/v1/admin/order-settings')
        .send({ version: s2.version, approvalThresholdMinor: null })
        .expect(200);
    }

    // The approver's own order over their (temporary) limit needs someone else.
    const ap = (await company()).buyers.find((b: { email: string }) => b.email === 'approver@shree.demo');
    await au
      .patch(`/v1/admin/companies/${shree}/buyers/${ap.id}`)
      .send({ version: ap.version, orderLimitMinor: '100' })
      .expect(200);
    try {
      const own = await priceAndOrder(approver, [{ sku: item.sku, quantity: 1 }], pune);
      expect(own.placed.body.status).toBe('awaiting_buyer_approval');
      expect(
        (await approver.post(`/v1/storefront/b2b/orders/${own.placed.body.id}/approve`).send({})).body.code,
      ).toBe('SEPARATION_OF_DUTIES');
      const rejected = await approver
        .post(`/v1/storefront/b2b/orders/${own.placed.body.id}/reject`)
        .send({ reason: 'Placed by mistake' });
      expect(rejected.body.code).toBe('SEPARATION_OF_DUTIES');
    } finally {
      const fresh = (await company()).buyers.find(
        (b: { email: string }) => b.email === 'approver@shree.demo',
      );
      await au
        .patch(`/v1/admin/companies/${shree}/buyers/${fresh.id}`)
        .send({ version: fresh.version, orderLimitMinor: null })
        .expect(200);
    }
  });
});

describe('RFQ negotiation and partial acceptance (B-07)', () => {
  it('RFQ → messages → quotation → accept some lines at the frozen price', async () => {
    const a = await wholesaleItem('4000.00', '30');
    const b = await wholesaleItem('6000.00', '30');
    const rfq = await buyer.post('/v1/storefront/b2b/rfqs').send({
      lines: [
        { sku: a.sku, quantity: 5 },
        { sku: b.sku, quantity: 5, note: 'Matte finish?' },
      ],
      note: 'Festival order',
      locationId: mumbai,
    });
    expect(rfq.status, JSON.stringify(rfq.body)).toBe(201);
    expect(rfq.body).toMatchObject({
      status: 'submitted',
      number: expect.stringMatching(/^RFQ-\d{6}$/),
      messages: [{ author: 'buyer', body: 'Festival order' }],
    });
    const inbox = await au.get('/v1/admin/rfqs').query({ companyId: shree });
    expect(inbox.body.items.map((r: { id: string }) => r.id)).toContain(rfq.body.id);
    await au
      .post(`/v1/admin/rfqs/${rfq.body.id}/messages`)
      .send({ body: 'Matte finish available at the same price' })
      .expect(200);
    const until = new Date(Date.now() + 2 * 24 * 3600_000).toISOString();
    const quoted = await au
      .post(`/v1/admin/rfqs/${rfq.body.id}/quote`)
      .send({ version: rfq.body.version, validUntil: until, notes: 'Festival pricing' });
    expect(quoted.status, JSON.stringify(quoted.body)).toBe(200);
    expect(quoted.body.status).toBe('quoted');
    expect(quoted.body.messages.map((m: { author: string }) => m.author)).toEqual([
      'buyer',
      'staff',
      'staff',
    ]);

    // The list price rises after quoting; the accepted line keeps the quoted price.
    await au
      .put(`/v1/admin/pricing/books/${shreeBook}/list-prices`)
      .send({ items: [{ variantId: b.variantId, amount: '9999.00' }] })
      .expect(200);
    const qs = await buyer.get('/v1/storefront/b2b/quotations');
    const q = qs.body.items.find((x: { rfqId: string }) => x.rfqId === rfq.body.id);
    expect(q).toMatchObject({
      status: 'sent',
      totalMinor: '5000000',
      lines: [
        { index: 0, totalMinor: '2000000' },
        { index: 1, totalMinor: '3000000' },
      ],
    });
    const accepted = await buyer
      .post(`/v1/storefront/b2b/quotations/${q.id}/accept`)
      .send({ lineIndexes: [1], locationId: mumbai, poNumber: 'PO-RFQ-1' });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(accepted.body).toMatchObject({
      origin: 'quotation',
      totalMinor: '3000000',
      lines: [{ sku: b.sku, quantity: 5 }],
    });
    expect((await buyer.get(`/v1/storefront/b2b/rfqs/${rfq.body.id}`)).body.status).toBe('accepted');
    expect(
      (await buyer.post(`/v1/storefront/b2b/quotations/${q.id}/accept`).send({ locationId: mumbai })).status,
    ).toBe(409);

    // An expired quotation cannot be accepted.
    const rfq2 = await buyer.post('/v1/storefront/b2b/rfqs').send({ lines: [{ sku: a.sku, quantity: 5 }] });
    await au
      .post(`/v1/admin/rfqs/${rfq2.body.id}/quote`)
      .send({ version: rfq2.body.version, validUntil: until })
      .expect(200);
    const q2 = (await buyer.get('/v1/storefront/b2b/quotations')).body.items.find(
      (x: { rfqId: string }) => x.rfqId === rfq2.body.id,
    );
    await ownerPool.query("update quotations set valid_until = now() - interval '1 minute' where id = $1", [
      q2.id,
    ]);
    expect(
      (await buyer.post(`/v1/storefront/b2b/quotations/${q2.id}/accept`).send({ locationId: mumbai })).body
        .code,
    ).toBe('QUOTE_EXPIRED');
  });
});

describe('sales reps, invitations and isolation (B-08, B-09, B-10, B-02)', () => {
  it('a sales rep sees only assigned companies and their RFQs', async () => {
    expect((await rep.get('/v1/admin/companies')).body.items).toHaveLength(0);
    expect((await rep.get(`/v1/admin/companies/${shree}`)).status).toBe(404);
    expect((await rep.get('/v1/admin/rfqs')).body.items).toHaveLength(0);
    await patchCompany({ salesRepUserId: repUserId });
    try {
      expect((await rep.get('/v1/admin/companies')).body.items.map((c: { id: string }) => c.id)).toEqual([
        shree,
      ]);
      expect((await rep.get('/v1/admin/rfqs')).body.items.length).toBeGreaterThan(0);
    } finally {
      await patchCompany({ salesRepUserId: null });
    }
  });

  it('invitations are single use; another company sees nothing of Shree', async () => {
    expect(
      (
        await au
          .post('/v1/admin/companies')
          .send({ name: 'Bad GSTIN Co', code: `BAD-${uid()}`, gstin: '12345' })
      ).status,
    ).toBe(400);
    const other = await au
      .post('/v1/admin/companies')
      .send({ name: `Other Traders ${uid()}`, code: `OT-${uid()}`, gstin: '27AAACZ9999Z1Z5' });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    const loc = await au.post(`/v1/admin/companies/${other.body.id}/locations`).send({
      name: 'Main',
      code: 'main',
      address: { line1: '1 Test Rd', city: 'Surat', countryCode: 'IN' },
    });
    expect(loc.status).toBe(201);
    const email = `buyer-${uid().toLowerCase()}@other.test`;
    const inv = await au.post(`/v1/admin/companies/${other.body.id}/buyers`).send({ email, role: 'admin' });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const anon = portal();
    const preview = await anon
      .post('/v1/storefront/b2b/invitations/preview')
      .send({ token: inv.body.invitationToken });
    expect(preview.body).toMatchObject({ email, userExists: false, role: 'admin' });
    const acc = await anon
      .post('/v1/storefront/b2b/invitations/accept')
      .send({ token: inv.body.invitationToken, displayName: 'Other Buyer', password: TEST_PASSWORD });
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    expect(
      (
        await anon
          .post('/v1/storefront/b2b/invitations/accept')
          .send({ token: inv.body.invitationToken, password: TEST_PASSWORD })
      ).body.code,
    ).toBe('INVITATION_INVALID');
    const ob = await buyerLogin(email);
    const shreeOrder = (await buyer.get('/v1/storefront/b2b/orders')).body.items[0];
    expect((await ob.get(`/v1/storefront/b2b/orders/${shreeOrder.id}`)).status).toBe(404);
    expect((await ob.get('/v1/storefront/b2b/orders')).body.items).toHaveLength(0);
    const shreeRfq = (await buyer.get('/v1/storefront/b2b/rfqs')).body.items[0];
    expect((await ob.get(`/v1/storefront/b2b/rfqs/${shreeRfq.id}`)).status).toBe(404);
    expect((await ob.get('/v1/storefront/b2b/me').set('x-company-id', shree)).status).toBe(404);
    expect((await ob.get('/v1/storefront/b2b/quotations')).body.items).toHaveLength(0);
  });

  it('other tenants cannot reach companies, and the buyer location scope hides other locations', async () => {
    // Lumière (B2C) has no B2B feature: refused before any lookup, so nothing about Shree is revealed.
    expect((await lu.get(`/v1/admin/companies/${shree}`)).body.code).toBe('FEATURE_NOT_ENTITLED');
    expect((await lu.get('/v1/admin/companies')).body.code).toBe('FEATURE_NOT_ENTITLED');
    const puneOrders = await approver.get('/v1/storefront/b2b/orders');
    const puneOrder = puneOrders.body.items.find((o: { id: string }) => o.id);
    expect(puneOrder).toBeDefined();
    const all = await ownerPool.query('select id from orders where company_location_id = $1', [pune]);
    for (const row of all.rows)
      expect((await buyer.get(`/v1/storefront/b2b/orders/${row.id}`)).status).toBe(404);
  });
});
