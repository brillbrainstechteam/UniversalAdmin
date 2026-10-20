import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

/** Phase 10 acceptance (G-01 … G-09): online store content, domains, discounts, segments/campaigns, reports. */
let app: INestApplication;
let northwind: string;
let lumiere: string;
let nwMain: string;
let nwChannel: string;
let luChannel: string;
const NW = 'northwind.localhost';
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
    del: (p: string) => agent.delete(p).set('x-tenant-id', tenant).set(CSRF),
  };
}
type Staff = ReturnType<typeof scoped>;
let nw: Staff;
let nwViewer: Staff;
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
function shopper(host = NW) {
  const agent = request.agent(app.getHttpServer());
  return {
    agent,
    get: (p: string) => agent.get(p).set('Host', host),
    post: (p: string) => agent.post(p).set('Host', host).set(CSRF),
    put: (p: string) => agent.put(p).set('Host', host).set(CSRF),
  };
}
type Shopper = ReturnType<typeof shopper>;
async function register(consent = { email: false, sms: false, whatsapp: false }) {
  const s = shopper();
  const r = await s.post('/v1/storefront/account/register').send({
    email: `g-${uid().toLowerCase()}@example.test`,
    password: TEST_PASSWORD,
    displayName: 'Growth Customer',
    marketing: consent,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return Object.assign(s, { id: r.body.customer.id as string });
}

async function nwItem(price: string, stock = '50') {
  const sku = `G-${uid()}`;
  const p = await nw.post('/v1/admin/products').send({ title: `Growth item ${sku}`, variants: [{ sku }] });
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
  return variantId;
}

/** A cart (as `who` when given, so customer-only discounts can apply) with lines and an optional code. */
async function cart(lines: unknown[], code: string | null = null, who?: Shopper) {
  const c = await sf(NW).post('/v1/storefront/carts');
  const put = (p: string) => (who ? who.put(p) : sf(NW).put(p)).set('x-cart-token', c.body.cartToken);
  let r = await put(`/v1/storefront/carts/${c.body.cartId}/lines`).send({ lines });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  if (code) {
    r = await put(`/v1/storefront/carts/${c.body.cartId}/discount`).send({ code });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  return { id: c.body.cartId as string, token: c.body.cartToken as string, body: r.body };
}
function checkout(c: Awaited<ReturnType<typeof cart>>, who?: Shopper, extra: Record<string, unknown> = {}) {
  return (who ? who.post('/v1/storefront/checkouts') : sf(NW).post('/v1/storefront/checkouts'))
    .set('idempotency-key', key())
    .send({
      cartId: c.id,
      cartToken: c.token,
      quoteId: c.body.quote.id,
      acknowledgedTotalMinor: c.body.quote.totalMinor,
      contact: { name: 'Growth Shopper', email: 'growth@example.test' },
      shippingAddress: address,
      ...extra,
    });
}
async function pay(orderId: string, token: string) {
  const r = await sf(NW)
    .post(`/v1/storefront/orders/${orderId}/sandbox-payment`)
    .send({ cartToken: token, outcome: 'succeeded' });
  expect(r.body.status, JSON.stringify(r.body)).toBe('confirmed');
}
const discount = (over: Record<string, unknown>) => ({
  name: `Discount ${uid()}`,
  code: null,
  mode: 'percent',
  value: '10',
  startsAt: new Date(Date.now() - 3600_000).toISOString(),
  ...over,
});
async function createDiscount(over: Record<string, unknown>) {
  const r = await nw.post('/v1/admin/discounts').send(discount(over));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}
async function disable(d: { id: string }) {
  const cur = (await nw.get('/v1/admin/discounts').query({ q: '' })).body.items.find(
    (x: { id: string }) => x.id === d.id,
  );
  await nw
    .put(`/v1/admin/discounts/${d.id}`)
    .send({
      ...discount({}),
      ...cur,
      segmentId: cur.segment?.id ?? null,
      status: 'disabled',
      version: cur.version,
    })
    .expect(200);
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
  nwChannel = (
    await one<{ id: string }>(
      "select channel_id as id from channel_domains where hostname = 'northwind.localhost'",
      [],
    )
  ).id;
  luChannel = (
    await one<{ id: string }>(
      "select channel_id as id from channel_domains where hostname = 'lumiere.localhost'",
      [],
    )
  ).id;
  nw = scoped(await login(app, 'owner@northwind.demo'), northwind);
  nwViewer = scoped(await login(app, (await createMember(northwind, ['viewer'])).email), northwind);
  lu = scoped(await login(app, 'owner@lumiere.demo'), lumiere);
});
afterAll(async () => {
  await app.close();
});

describe('online store content (G-01, G-02)', () => {
  it('serves only published content; publishing versions it; rollback republishes an old version', async () => {
    const slug = `about-${uid().toLowerCase()}`;
    const docs = await nw.get('/v1/admin/online-store/documents').query({ channelId: nwChannel });
    expect(docs.body.items.map((d: { kind: string; key: string }) => `${d.kind}:${d.key}`)).toEqual(
      expect.arrayContaining(['theme:main', 'menu:header', 'menu:footer', 'banner:main']),
    );
    const page = await nw.post('/v1/admin/online-store/pages').send({
      channelId: nwChannel,
      slug,
      content: { title: 'About us', blocks: [{ type: 'text', text: 'Version one' }] },
    });
    expect(page.status, JSON.stringify(page.body)).toBe(201);
    expect((await sf(NW).get(`/v1/storefront/pages/${slug}`)).status).toBe(404);
    expect(
      (await sf(NW).get('/v1/storefront/site')).body.pages.some((p: { slug: string }) => p.slug === slug),
    ).toBe(false);
    const v1 = await nw
      .post(`/v1/admin/online-store/documents/${page.body.id}/publish`)
      .send({ version: page.body.version });
    expect(v1.body).toMatchObject({ live: true, publishedVersion: 1, hasChanges: false });
    expect((await sf(NW).get(`/v1/storefront/pages/${slug}`)).body.blocks[0].text).toBe('Version one');
    // Unsafe content is refused.
    expect(
      (
        await nw.put(`/v1/admin/online-store/documents/${page.body.id}/draft`).send({
          version: v1.body.version,
          content: { title: 'X', blocks: [{ type: 'cta', label: 'Go', href: 'javascript:alert(1)' }] },
        })
      ).status,
    ).toBe(400);
    const draft = await nw.put(`/v1/admin/online-store/documents/${page.body.id}/draft`).send({
      version: v1.body.version,
      content: { title: 'About us', blocks: [{ type: 'text', text: 'Version two' }] },
    });
    expect(draft.body.hasChanges).toBe(true);
    expect((await sf(NW).get(`/v1/storefront/pages/${slug}`)).body.blocks[0].text).toBe('Version one'); // draft invisible
    const v2 = await nw
      .post(`/v1/admin/online-store/documents/${page.body.id}/publish`)
      .send({ version: draft.body.version, note: 'Copy update' });
    expect((await sf(NW).get(`/v1/storefront/pages/${slug}`)).body.blocks[0].text).toBe('Version two');
    const back = await nw
      .post(`/v1/admin/online-store/documents/${page.body.id}/publish`)
      .send({ version: v2.body.version, fromVersion: 1 });
    expect(back.body).toMatchObject({
      publishedVersion: 3,
      versions: [{ version: 3, note: 'Rollback to version 1' }, { version: 2 }, { version: 1 }],
    });
    expect((await sf(NW).get(`/v1/storefront/pages/${slug}`)).body.blocks[0].text).toBe('Version one');
    await expect(
      ownerPool.query('update site_document_versions set content = $2 where document_id = $1', [
        page.body.id,
        '{}',
      ]),
    ).rejects.toThrow();
    const off = await nw
      .post(`/v1/admin/online-store/documents/${page.body.id}/unpublish`)
      .send({ version: back.body.version });
    expect(off.body.live).toBe(false);
    expect((await sf(NW).get(`/v1/storefront/pages/${slug}`)).status).toBe(404);
    expect(
      (await nwViewer.get('/v1/admin/online-store/documents').query({ channelId: nwChannel })).status,
    ).toBe(403);
    expect((await lu.get(`/v1/admin/online-store/documents/${page.body.id}`)).status).toBe(404);
  });

  it('preview tokens show drafts only for their own store, and a forged token shows nothing new', async () => {
    const slug = `preview-${uid().toLowerCase()}`;
    const page = await nw
      .post('/v1/admin/online-store/pages')
      .send({ channelId: nwChannel, slug, content: { title: 'Draft only', blocks: [] } });
    const token = (await nw.post('/v1/admin/online-store/preview-tokens').send({ channelId: nwChannel }))
      .body;
    expect(token).toMatchObject({ hostname: NW });
    const seen = await sf(NW).get(`/v1/storefront/pages/${slug}`).set('x-preview-token', token.token);
    expect(seen.body).toMatchObject({ title: 'Draft only', preview: true });
    expect((await sf(NW).get('/v1/storefront/site').set('x-preview-token', token.token)).body.preview).toBe(
      true,
    );
    const forged = `${token.token.split('.')[0]}.${'A'.repeat(43)}`;
    expect((await sf(NW).get(`/v1/storefront/pages/${slug}`).set('x-preview-token', forged)).status).toBe(
      404,
    );
    const other = (await lu.post('/v1/admin/online-store/preview-tokens').send({ channelId: luChannel })).body
      .token;
    expect((await sf(NW).get(`/v1/storefront/pages/${slug}`).set('x-preview-token', other)).status).toBe(404);
    expect(page.status).toBe(201);
  });

  it('a published theme and banner reach the storefront; a scheduled banner waits for its start', async () => {
    const docs = (await nw.get('/v1/admin/online-store/documents').query({ channelId: nwChannel })).body
      .items;
    const theme = (
      await nw.get(
        `/v1/admin/online-store/documents/${docs.find((d: { kind: string }) => d.kind === 'theme').id}`,
      )
    ).body;
    const brand = `Northwind ${uid()}`;
    const saved = await nw
      .put(`/v1/admin/online-store/documents/${theme.id}/draft`)
      .send({ version: theme.version, content: { ...theme.draft, brandName: brand } });
    expect((await sf(NW).get('/v1/storefront/config')).body.theme.brandName).not.toBe(brand);
    const pub = await nw
      .post(`/v1/admin/online-store/documents/${theme.id}/publish`)
      .send({ version: saved.body.version });
    expect((await sf(NW).get('/v1/storefront/config')).body.theme.brandName).toBe(brand);
    expect((await sf(NW).get('/v1/storefront/site')).body.theme.brandName).toBe(brand);
    // Restore the previous theme for other suites.
    await nw
      .post(`/v1/admin/online-store/documents/${theme.id}/publish`)
      .send({ version: pub.body.version, fromVersion: pub.body.versions[1].version })
      .expect(200);
    const banner = (
      await nw.get(
        `/v1/admin/online-store/documents/${docs.find((d: { kind: string }) => d.kind === 'banner').id}`,
      )
    ).body;
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const b1 = await nw
      .put(`/v1/admin/online-store/documents/${banner.id}/draft`)
      .send({ version: banner.version, content: { message: 'Starts tomorrow', startsAt: future } });
    const b1p = await nw
      .post(`/v1/admin/online-store/documents/${banner.id}/publish`)
      .send({ version: b1.body.version });
    expect((await sf(NW).get('/v1/storefront/site')).body.banner).toBeNull();
    const b2 = await nw
      .put(`/v1/admin/online-store/documents/${banner.id}/draft`)
      .send({ version: b1p.body.version, content: { message: 'Free gift wrap this week' } });
    const b2p = await nw
      .post(`/v1/admin/online-store/documents/${banner.id}/publish`)
      .send({ version: b2.body.version });
    expect((await sf(NW).get('/v1/storefront/site')).body.banner).toMatchObject({
      message: 'Free gift wrap this week',
    });
    await nw
      .post(`/v1/admin/online-store/documents/${banner.id}/unpublish`)
      .send({ version: b2p.body.version })
      .expect(200);
  });
});

describe('domains and redirects (G-03)', () => {
  it('a new domain resolves only once verified; DNS failures are reported; duplicates refused', async () => {
    const host = `shop-${uid().toLowerCase()}.test`;
    const added = await nw
      .post('/v1/admin/online-store/domains')
      .send({ channelId: nwChannel, hostname: host });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({
      status: 'pending',
      verificationRecord: { type: 'TXT', name: `_uc-verify.${host}` },
    });
    expect((await sf(host).get('/v1/storefront/config')).status).toBe(404);
    const ok = await nw.post(`/v1/admin/online-store/domains/${added.body.id}/verify`);
    expect(ok.body).toMatchObject({ status: 'verified', verificationRecord: null }); // development verification (.test)
    expect((await sf(host).get('/v1/storefront/config')).status).toBe(200);
    expect(
      (await nw.post('/v1/admin/online-store/domains').send({ channelId: nwChannel, hostname: NW })).status,
    ).toBe(409);
    expect(
      (await lu.post('/v1/admin/online-store/domains').send({ channelId: luChannel, hostname: host })).status,
    ).toBe(409);
    const real = await nw
      .post('/v1/admin/online-store/domains')
      .send({ channelId: nwChannel, hostname: `shop-${uid().toLowerCase()}.example.invalid` });
    const failed = await nw.post(`/v1/admin/online-store/domains/${real.body.id}/verify`);
    expect(failed.status).toBe(422);
    expect(failed.body.code).toBe('DOMAIN_NOT_VERIFIED');
    await nw.del(`/v1/admin/online-store/domains/${real.body.id}`).expect(204);
    await nw.del(`/v1/admin/online-store/domains/${added.body.id}`).expect(204);
  }, 30_000);

  it('redirects resolve, and chains and loops are refused', async () => {
    const from = `/old-${uid().toLowerCase()}`;
    const r = await nw
      .post('/v1/admin/online-store/redirects')
      .send({ channelId: nwChannel, fromPath: from, toPath: '/pages/about' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await sf(NW).get('/v1/storefront/redirects').query({ path: from })).body).toEqual({
      toPath: '/pages/about',
      statusCode: 301,
    });
    expect(
      (
        await nw
          .post('/v1/admin/online-store/redirects')
          .send({ channelId: nwChannel, fromPath: '/pages/about', toPath: '/x' })
      ).status,
    ).toBe(400); // loop into the source
    expect(
      (
        await nw
          .post('/v1/admin/online-store/redirects')
          .send({ channelId: nwChannel, fromPath: `/new-${uid().toLowerCase()}`, toPath: from })
      ).status,
    ).toBe(400); // chain
    await nw.del(`/v1/admin/online-store/redirects/${r.body.id}`).expect(204);
    expect((await sf(NW).get('/v1/storefront/redirects').query({ path: from })).status).toBe(404);
  });
});

describe('discounts (G-04 … G-07)', () => {
  it('a code applies before tax with an exact split and is recorded on the order', async () => {
    const v = await nwItem('10.00');
    const code = `SAVE${uid()}`.slice(0, 20);
    const d = await createDiscount({ code, value: '10', minSubtotalMinor: '1500' });
    const small = await cart([{ variantId: v }], code);
    expect(small.body.promotions).toMatchObject({
      applied: [],
      code,
      codeProblem: expect.stringContaining('Spend at least'),
    });
    expect(small.body.quote.totalMinor).toBe('1000');
    const c = await cart([{ variantId: v, quantity: 3 }], code);
    expect(c.body.promotions.applied).toEqual([
      { discountId: d.id, code, label: `Code ${code}`, discountMinor: '300' },
    ]);
    expect(c.body.quote.totalMinor).toBe('2700');
    const placed = await checkout(c);
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    await pay(placed.body.id, c.token);
    const o = (await nw.get(`/v1/admin/orders/${placed.body.id}`)).body;
    expect(o).toMatchObject({
      subtotalMinor: '3000',
      discountMinor: '300',
      totalMinor: '2700',
      promotions: [{ code, amountMinor: '300' }],
    });
    expect(BigInt(o.subtotalMinor) - BigInt(o.discountMinor) + BigInt(o.taxMinor)).toBe(BigInt(o.totalMinor));
    expect(o.lines[0].priceSnapshot.breakdown.promotions).toEqual([
      { id: d.id, label: `Code ${code}`, discountMinor: '300' },
    ]);
    expect(
      (await one<{ used_count: number }>('select used_count from discounts where id = $1', [d.id]))
        .used_count,
    ).toBe(1);
    await expect(
      ownerPool.query('delete from discount_redemptions where discount_id = $1', [d.id]),
    ).rejects.toThrow();
  });

  it('refuses codes that are unknown, not started, expired, disabled, for other channels, or customer-only for guests', async () => {
    const v = await nwItem('20.00');
    const storeId = (
      await one<{ store_id: string }>('select store_id from channels where id = $1', [nwChannel])
    ).store_id;
    const popup = await nw
      .post('/v1/admin/channels')
      .send({ storeId, code: `popup-${uid().toLowerCase()}`, name: 'Pop-up shop', type: 'b2c_storefront' });
    expect(popup.status, JSON.stringify(popup.body)).toBe(201);
    const nwPopup = popup.body.id as string;
    const mk = (over: Record<string, unknown>) => createDiscount({ code: `C${uid()}`.slice(0, 20), ...over });
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ startsAt: new Date(Date.now() + 86_400_000).toISOString() }, /not valid yet/],
      [
        {
          startsAt: new Date(Date.now() - 7_200_000).toISOString(),
          endsAt: new Date(Date.now() - 3_600_000).toISOString(),
        },
        /expired/,
      ],
      [{ status: 'disabled' }, /not active/],
      [{ channelIds: [nwPopup] }, /not valid in this store/],
      [{ perCustomerLimit: 1 }, /Sign in/],
      [{ mode: 'fixed', value: '5', currency: 'INR' }, /currency/],
    ];
    for (const [over, why] of cases) {
      const d = await mk(over);
      const c = await cart([{ variantId: v }], d.code);
      expect(c.body.promotions.codeProblem, JSON.stringify(over)).toMatch(why);
      expect(c.body.quote.totalMinor).toBe('2000');
    }
    expect((await cart([{ variantId: v }], 'NOSUCHCODE')).body.promotions.codeProblem).toMatch(
      /does not exist/,
    );
    // The browser cannot set a discount: acknowledging a lower total is refused.
    const c = await cart([{ variantId: v }]);
    expect((await checkout(c, undefined, { acknowledgedTotalMinor: '1' })).status).toBe(422);
  });

  it('per-customer limits and segment-only codes are enforced for signed-in customers', async () => {
    const v = await nwItem('8.00');
    const once = await createDiscount({ code: `ONCE${uid()}`.slice(0, 20), perCustomerLimit: 1 });
    const a = await register();
    const c1 = await cart([{ variantId: v }], once.code, a);
    expect(c1.body.promotions.applied).toHaveLength(1);
    const p1 = await checkout(c1, a);
    expect(p1.status, JSON.stringify(p1.body)).toBe(201);
    await pay(p1.body.id, c1.token);
    expect((await cart([{ variantId: v }], once.code, a)).body.promotions.codeProblem).toMatch(
      /already used/,
    );
    // Segment: customers with at least one confirmed order.
    const seg = await nw
      .post('/v1/admin/marketing/segments')
      .send({ name: `Buyers ${uid()}`, definition: { minOrders: 1 } });
    expect(seg.status, JSON.stringify(seg.body)).toBe(201);
    const vip = await createDiscount({ code: `VIP${uid()}`.slice(0, 20), segmentId: seg.body.id });
    const b = await register();
    expect((await cart([{ variantId: v }], vip.code, b)).body.promotions.codeProblem).toMatch(
      /not available for your account/,
    );
    expect((await cart([{ variantId: v }], vip.code, a)).body.promotions.applied).toHaveLength(1);
  });

  it('combination: non-combinable → only the larger applies; combinable → both', async () => {
    const v = await nwItem('50.00');
    const auto = await createDiscount({ value: '5', combinable: false }); // automatic 5% = 2.50
    try {
      const code = await createDiscount({
        code: `FIX${uid()}`.slice(0, 20),
        mode: 'fixed',
        value: '4',
        currency: 'GBP',
        combinable: false,
      });
      const c = await cart([{ variantId: v }], code.code);
      expect(c.body.promotions.applied.map((p: { discountMinor: string }) => p.discountMinor)).toEqual([
        '400',
      ]);
      expect(c.body.quote.totalMinor).toBe('4600');
      const small = await createDiscount({
        code: `TINY${uid()}`.slice(0, 20),
        mode: 'fixed',
        value: '1',
        currency: 'GBP',
        combinable: false,
      });
      const c2 = await cart([{ variantId: v }], small.code);
      expect(c2.body.promotions.applied.map((p: { discountMinor: string }) => p.discountMinor)).toEqual([
        '250',
      ]);
      expect(c2.body.promotions.codeProblem).toMatch(/cannot be combined/);
      await disable(auto);
      const auto2 = await createDiscount({ value: '5', combinable: true });
      try {
        const both = await createDiscount({
          code: `BOTH${uid()}`.slice(0, 20),
          mode: 'fixed',
          value: '4',
          currency: 'GBP',
          combinable: true,
        });
        const c3 = await cart([{ variantId: v }], both.code);
        expect(
          c3.body.promotions.applied.map((p: { discountMinor: string }) => p.discountMinor).sort(),
        ).toEqual(['250', '400']);
        expect(c3.body.quote.totalMinor).toBe('4350');
      } finally {
        await disable(auto2);
      }
    } finally {
      await disable(auto).catch(() => undefined);
    }
  });

  it('concurrent checkouts cannot exceed a usage limit', async () => {
    const v = await nwItem('12.00');
    const d = await createDiscount({ code: `LAST${uid()}`.slice(0, 20), usageLimit: 1 });
    const [a, b] = [await cart([{ variantId: v }], d.code), await cart([{ variantId: v }], d.code)];
    expect(a.body.quote.totalMinor).toBe('1080');
    const results = await Promise.all([checkout(a), checkout(b)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('PRICE_CHANGED');
    expect(
      await one<{ used_count: number; n: number }>(
        'select used_count, (select count(*)::int from discount_redemptions where discount_id = $1) as n from discounts where id = $1',
        [d.id],
      ),
    ).toEqual({ used_count: 1, n: 1 });
    expect((await nw.get('/v1/admin/discounts').query({ q: d.code })).body.items[0]).toMatchObject({
      state: 'used_up',
      usedCount: 1,
    });
    // Once used, the terms cannot change; viewers cannot manage discounts.
    expect(
      (
        await nw
          .put(`/v1/admin/discounts/${d.id}`)
          .send({ ...discount({}), code: d.code, value: '50', usageLimit: 1, version: d.version })
      ).status,
    ).toBe(409);
    expect((await nwViewer.get('/v1/admin/discounts')).status).toBe(403);
  });
});

describe('segments and campaigns (G-08)', () => {
  it('only customers with granted consent for the channel become recipients; nothing is sent', async () => {
    const yes = await register({ email: true, sms: false, whatsapp: false });
    const no = await register({ email: false, sms: true, whatsapp: false });
    const seg = await nw
      .post('/v1/admin/marketing/segments')
      .send({ name: `New ${uid()}`, definition: { registeredWithinDays: 1 } });
    const members = await nw.get(`/v1/admin/marketing/segments/${seg.body.id}/members`).query({ limit: 100 });
    const ids = members.body.items.map((m: { id: string }) => m.id);
    expect(ids).toEqual(expect.arrayContaining([yes.id, no.id]));
    const camp = await nw.post('/v1/admin/marketing/campaigns').send({
      name: 'Welcome',
      channel: 'email',
      segmentId: seg.body.id,
      subject: 'Hello',
      body: 'Welcome to the store',
    });
    expect(camp.status, JSON.stringify(camp.body)).toBe(201);
    const prepared = await nw
      .post(`/v1/admin/marketing/campaigns/${camp.body.id}/prepare`)
      .send({ version: camp.body.version });
    expect(prepared.body).toMatchObject({
      status: 'prepared',
      sendBlockedReason: expect.stringContaining('nothing is sent'),
    });
    expect(prepared.body.recipientCount + prepared.body.excludedNoConsent).toBe(members.body.count);
    const rec = await nw
      .get(`/v1/admin/marketing/campaigns/${camp.body.id}/recipients`)
      .query({ limit: 100 });
    const recIds = rec.body.items.map((r: { customerId: string }) => r.customerId);
    expect(recIds).toContain(yes.id);
    expect(recIds).not.toContain(no.id);
    expect(rec.body.items.every((r: { status: string }) => r.status === 'not_sent')).toBe(true);
    expect(
      (
        await nw.put(`/v1/admin/marketing/campaigns/${camp.body.id}`).send({
          name: 'X',
          channel: 'email',
          segmentId: seg.body.id,
          subject: 'Hi',
          body: 'B',
          version: prepared.body.version,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await nw
          .post('/v1/admin/marketing/campaigns')
          .send({ name: 'No subject', channel: 'email', segmentId: seg.body.id, body: 'B' })
      ).status,
    ).toBe(400);
    expect((await lu.get(`/v1/admin/marketing/segments/${seg.body.id}/members`)).status).toBe(404);
    expect((await nwViewer.get('/v1/admin/marketing/segments')).status).toBe(403);
  });
});

describe('reports (G-09)', () => {
  it('match independent queries, carry definitions and generatedAt, export CSV safely, and stay per tenant', async () => {
    const v = await nwItem('9.00');
    const source = `=src${uid().toLowerCase()}`;
    const c = await cart([{ variantId: v, quantity: 2 }]);
    const placed = await checkout(c, undefined, {
      attribution: { source, medium: 'email', campaign: 'spring', landingPath: '/' },
    });
    await pay(placed.body.id, c.token);
    const sales = await nw.get('/v1/admin/reports/sales');
    expect(sales.status, JSON.stringify(sales.body)).toBe(200);
    expect(sales.body.definition.metrics.find((m: { key: string }) => m.key === 'net').formula).toMatch(
      /refunds/,
    );
    expect(Date.parse(sales.body.generatedAt)).toBeGreaterThan(Date.now() - 60_000);
    const { from, to, timezone } = sales.body.filters;
    const oracle = await one<{ n: number; total: string }>(
      `select count(*)::int as n, coalesce(sum(total_minor), 0)::text as total from orders
        where tenant_id = $1 and status = 'confirmed' and currency = 'GBP'
          and confirmed_at >= ($2::date::timestamp at time zone $4) and confirmed_at < (($3::date + 1)::timestamp at time zone $4)`,
      [northwind, from, to, timezone],
    );
    expect(sales.body.totals.orders).toBe(oracle.n);
    expect(sales.body.totals.total).toBe(oracle.total);
    const attr = await nw.get('/v1/admin/reports/attribution');
    expect(attr.body.rows.find((r: { source: string }) => r.source === source)).toMatchObject({
      medium: 'email',
      campaign: 'spring',
      orders: 1,
      total: '1800',
    });
    expect(attr.body.definition.notes.join(' ')).toMatch(/No acquisition cost/);
    const conv = await nw.get('/v1/admin/reports/conversion');
    const carts = await one<{ n: number }>(
      `select count(*)::int as n from carts where tenant_id = $1 and created_at >= ($2::date::timestamp at time zone $4) and created_at < (($3::date + 1)::timestamp at time zone $4)`,
      [northwind, conv.body.filters.from, conv.body.filters.to, conv.body.filters.timezone],
    );
    expect(conv.body.totals.carts).toBe(carts.n);
    const csv = await nw.get('/v1/admin/reports/attribution').query({ format: 'csv' });
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\n')[0]).toBe('source,medium,campaign,orders,total_minor');
    expect(csv.text).toContain(`'${source},email,spring,1,1800`); // formula injection neutralised
    for (const k of ['metal_weight', 'stock_age', 'order_sync', 'channels'])
      expect((await nw.get(`/v1/admin/reports/${k}`)).status).toBe(200);
    expect(
      (await lu.get('/v1/admin/reports/attribution')).body.rows.some(
        (r: { source: string }) => r.source === source,
      ),
    ).toBe(false);
    expect(
      (await nw.get('/v1/admin/reports/sales').query({ from: '2026-12-01', to: '2026-01-01' })).status,
    ).toBe(400);
    expect((await nw.get('/v1/admin/reports/unknown')).status).toBe(400);
  });
});
