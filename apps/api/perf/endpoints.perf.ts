import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF, login, ownerPool, startApp, tenantId, type Agent } from '../test/helpers';

/**
 * Performance fixtures (Phase 11, P-perf). Loads a realistic volume for one merchant — 5 000 published products
 * and 20 000 orders — then times the endpoints staff and shoppers hit most. Budgets are generous single-node
 * development numbers (not production SLOs); the measured p50/p95 are printed for docs/implementation/phase-11.
 */
const PRODUCTS = 5_000;
const ORDERS = 20_000;
let app: INestApplication;
let northwind: string;
let nwChannel: string;
let staff: Agent;
const results: { name: string; p50: number; p95: number; max: number }[] = [];

async function time(name: string, runs: number, fn: () => Promise<{ status: number }>) {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = await fn();
    samples.push(performance.now() - t0);
    expect(r.status, name).toBeLessThan(300);
  }
  samples.sort((a, b) => a - b);
  const pick = (q: number) =>
    Math.round(samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]!);
  const row = { name, p50: pick(0.5), p95: pick(0.95), max: Math.round(samples.at(-1)!) };
  results.push(row);
  return row;
}

beforeAll(async () => {
  app = await startApp();
  northwind = await tenantId('northwind-general');
  nwChannel = (
    await ownerPool.query(
      "select channel_id as id from channel_domains where hostname = 'northwind.localhost'",
    )
  ).rows[0].id;
  staff = await login(app, 'owner@northwind.demo');
  const t0 = Date.now();
  await ownerPool.query(
    `with p as (
       insert into products (tenant_id, title, slug, status, description)
       select $1, 'Perf product ' || g, 'perf-product-' || g, 'active', 'Bulk performance fixture'
         from generate_series(1, $2) g
       returning id, slug)
     , v as (insert into variants (tenant_id, product_id, sku) select $1, id, upper(slug) from p returning product_id)
     insert into channel_publications (tenant_id, product_id, channel_id, status, published_at)
     select $1, product_id, $3, 'published', now() from v`,
    [northwind, PRODUCTS, nwChannel],
  );
  await ownerPool.query(
    `insert into orders (tenant_id, number, channel_id, origin, status, payment_status, payment_terms, currency,
                         subtotal_minor, discount_minor, tax_minor, total_minor, contact, confirmed_at, created_at)
     select $1, 'PERF-' || lpad(g::text, 7, '0'), $3, 'storefront', 'confirmed', 'paid', 'prepaid', 'GBP',
            1000 + g % 5000, 0, 0, 1000 + g % 5000, jsonb_build_object('name', 'Perf ' || g, 'email', 'perf' || g || '@example.test'),
            now() - (g % 60) * interval '1 day', now() - (g % 60) * interval '1 day'
       from generate_series(1, $2) g`,
    [northwind, ORDERS, nwChannel],
  );
  await ownerPool.query('analyze');
  console.log(`fixtures loaded in ${Date.now() - t0} ms (${PRODUCTS} products, ${ORDERS} orders)`);
});

afterAll(async () => {
  console.table(results);
  await app.close();
});

describe('performance fixtures', () => {
  it('admin lists and search stay fast with thousands of rows', async () => {
    const ctx = (r: request.Test) => r.set('x-tenant-id', northwind);
    expect(
      await time('GET /v1/admin/products (first page)', 30, () =>
        ctx(staff.get('/v1/admin/products').query({ limit: 50 })),
      ),
    ).toMatchObject({});
    await time('GET /v1/admin/products?q= (search)', 30, () =>
      ctx(staff.get('/v1/admin/products').query({ q: 'product 49', limit: 50 })),
    );
    await time('GET /v1/admin/orders (first page)', 30, () =>
      ctx(staff.get('/v1/admin/orders').query({ limit: 50 })),
    );
    await time('GET /v1/admin/orders?q= (search)', 30, () =>
      ctx(staff.get('/v1/admin/orders').query({ q: 'PERF-0012', limit: 50 })),
    );
    await time('GET /v1/admin/reports/sales (60 days, 20k orders)', 10, () =>
      ctx(
        staff
          .get('/v1/admin/reports/sales')
          .query({ from: new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10) }),
      ),
    );
    await time('GET /v1/admin/orders-export.csv (10k rows)', 3, () =>
      ctx(staff.get('/v1/admin/orders-export.csv')),
    );
    await time('GET /v1/admin/operations/health', 10, () => ctx(staff.get('/v1/admin/operations/health')));
    for (const r of results) expect(r.p95, r.name).toBeLessThan(r.name.includes('export') ? 15_000 : 2_000);
  });

  it('storefront catalog and pricing stay fast', async () => {
    const sf = () => request(app.getHttpServer());
    const list = await time('GET /v1/storefront/catalog/products', 30, () =>
      sf().get('/v1/storefront/catalog/products').set('Host', 'northwind.localhost').query({ limit: 24 }),
    );
    const variants = (
      await ownerPool.query(
        "select v.id from variants v join products p on p.id = v.product_id where p.tenant_id = $1 and p.slug like 'perf-product-%' limit 10",
        [northwind],
      )
    ).rows;
    const book = (await staff.get('/v1/admin/pricing/books').set('x-tenant-id', northwind)).body.items[0].id;
    await staff
      .put(`/v1/admin/pricing/books/${book}/list-prices`)
      .set('x-tenant-id', northwind)
      .set(CSRF)
      .send({ items: variants.map((v: { id: string }) => ({ variantId: v.id, amount: '12.00' })) })
      .expect(200);
    const quote = await time('POST /v1/storefront/pricing-quotes (10 lines)', 20, () =>
      sf()
        .post('/v1/storefront/pricing-quotes')
        .set('Host', 'northwind.localhost')
        .send({ lines: variants.map((v: { id: string }) => ({ variantId: v.id, quantity: 2 })) }),
    );
    expect(list.p95).toBeLessThan(2_000);
    expect(quote.p95).toBeLessThan(2_000);
  });
});
