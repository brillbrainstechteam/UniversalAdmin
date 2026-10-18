import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditCount,
  createMember,
  CSRF,
  login,
  ownerPool,
  startApp,
  tenantId,
  uniqueEmail,
  type Agent,
} from '../helpers';

// 1×1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

let app: INestApplication;
let aurum: string;
let northwind: string;
let lumiere: string;

type Client = ReturnType<typeof scoped>;
function scoped(agent: Agent, tenant: string) {
  return {
    get: (p: string) => agent.get(p).set('x-tenant-id', tenant),
    post: (p: string) => agent.post(p).set('x-tenant-id', tenant).set(CSRF),
    patch: (p: string) => agent.patch(p).set('x-tenant-id', tenant).set(CSRF),
    put: (p: string) => agent.put(p).set('x-tenant-id', tenant).set(CSRF),
    del: (p: string) => agent.delete(p).set('x-tenant-id', tenant).set(CSRF),
    agent,
  };
}
let au: Client; // Aurum owner (B2B jewellery)
let nw: Client; // Northwind owner (general commerce)

let seq = 0;
const sku = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const product = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  variants: [{ sku: sku('SKU') }],
  ...extra,
});

async function channelOf(tenant: string): Promise<string> {
  return (
    // The storefront channel behind the tenant's verified demo domain (other suites add extra channels).
    (
      await ownerPool.query(
        "select c.id from channels c join channel_domains d on d.channel_id = c.id where c.tenant_id = $1 and d.status = 'verified' limit 1",
        [tenant],
      )
    ).rows[0].id
  );
}

beforeAll(async () => {
  app = await startApp();
  aurum = await tenantId('aurum-wholesale');
  northwind = await tenantId('northwind-general');
  lumiere = await tenantId('lumiere-fine');
  au = scoped(await login(app, 'owner@aurum.demo'), aurum);
  nw = scoped(await login(app, 'owner@northwind.demo'), northwind);
});
afterAll(() => app.close());

describe('products: presets and validation (C-05, C-06)', () => {
  it('general-commerce product needs no jewellery data; jewellery type requires entitlement', async () => {
    const ok = await nw.post('/v1/admin/products').send(product('Canvas tote bag'));
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ productType: 'standard', status: 'draft', slug: 'canvas-tote-bag' });
    expect(ok.body.variants).toHaveLength(1);
    const jewel = await nw
      .post('/v1/admin/products')
      .send(product('Gold ring', { productType: 'jewellery' }));
    expect(jewel.status).toBe(403);
    expect(jewel.body.code).toBe('FEATURE_NOT_ENTITLED');
    const aurumJewel = await au
      .post('/v1/admin/products')
      .send(product('22K plain band', { productType: 'jewellery' }));
    expect(aurumJewel.status).toBe(201);
  });

  it('validates attribute values against definitions', async () => {
    const def = await nw.post('/v1/admin/attribute-definitions').send({
      key: 'material',
      label: 'Material',
      type: 'select',
      options: ['Cotton', 'Jute'],
      required: true,
    });
    expect(def.status).toBe(201);
    await nw
      .post('/v1/admin/attribute-definitions')
      .send({ key: 'capacity_l', label: 'Capacity (L)', type: 'number' });
    const missing = await nw.post('/v1/admin/products').send(product('Bag A'));
    expect(missing.status).toBe(400);
    expect(missing.body.details[0].path).toBe('attributes.material');
    const badOption = await nw
      .post('/v1/admin/products')
      .send(product('Bag B', { attributes: { material: 'Leather' } }));
    expect(badOption.body.details[0].path).toBe('attributes.material');
    const badNumber = await nw
      .post('/v1/admin/products')
      .send(product('Bag C', { attributes: { material: 'Jute', capacity_l: '12,5' } }));
    expect(badNumber.body.details[0].path).toBe('attributes.capacity_l');
    const unknown = await nw
      .post('/v1/admin/products')
      .send(product('Bag D', { attributes: { material: 'Jute', colour: 'red' } }));
    expect(unknown.status).toBe(400);
    const good = await nw
      .post('/v1/admin/products')
      .send(product('Bag E', { attributes: { material: 'Jute', capacity_l: '12.5' } }));
    expect(good.status).toBe(201);
    expect(good.body.attributes).toEqual({ material: 'Jute', capacity_l: '12.5' });
    // Cannot remove an option still in use.
    const inUse = await nw
      .patch(`/v1/admin/attribute-definitions/${def.body.id}`)
      .send({ version: 0, options: ['Cotton'] });
    expect(inUse.status).toBe(409);
    // The required attribute would break unrelated later tests in this tenant; relax it.
    await nw.patch(`/v1/admin/attribute-definitions/${def.body.id}`).send({ version: 0, required: false });
  });
});

describe('uniqueness (C-02)', () => {
  it('SKU is unique per tenant (case-insensitive) but reusable across tenants', async () => {
    const s = sku('DUP');
    expect(
      (await nw.post('/v1/admin/products').send({ title: 'Dup one', variants: [{ sku: s }] })).status,
    ).toBe(201);
    const dup = await nw
      .post('/v1/admin/products')
      .send({ title: 'Dup two', variants: [{ sku: s.toLowerCase() }] });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'DUPLICATE', details: { field: 'sku' } });
    const other = await au
      .post('/v1/admin/products')
      .send({ title: 'Dup elsewhere', variants: [{ sku: s }] });
    expect(other.status).toBe(201);
  });

  it('barcode unique per tenant; option combinations unique per product; slug unique per tenant', async () => {
    const p = await nw.post('/v1/admin/products').send({
      title: 'T-shirt',
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [{ sku: sku('TS'), barcode: '5012345678900', optionValues: { Size: 'S' } }],
    });
    expect(p.status).toBe(201);
    const dupCombo = await nw
      .post(`/v1/admin/products/${p.body.id}/variants`)
      .send({ sku: sku('TS'), optionValues: { Size: 's' } });
    expect(dupCombo.body).toMatchObject({ code: 'DUPLICATE', details: { field: 'optionValues' } });
    const badValue = await nw
      .post(`/v1/admin/products/${p.body.id}/variants`)
      .send({ sku: sku('TS'), optionValues: { Size: 'XL' } });
    expect(badValue.status).toBe(400);
    const dupBarcode = await nw
      .post(`/v1/admin/products/${p.body.id}/variants`)
      .send({ sku: sku('TS'), barcode: '5012345678900', optionValues: { Size: 'M' } });
    expect(dupBarcode.body.details.field).toBe('barcode');
    const ok = await nw
      .post(`/v1/admin/products/${p.body.id}/variants`)
      .send({ sku: sku('TS'), optionValues: { Size: 'M' } });
    expect(ok.status).toBe(201);
    expect(ok.body.variants).toHaveLength(2);
    const dupSlug = await nw
      .post('/v1/admin/products')
      .send({ title: 'T-shirt', variants: [{ sku: sku('TS2') }] });
    expect(dupSlug.body.details.field).toBe('slug');
  });

  it('several variants require options', async () => {
    const res = await nw
      .post('/v1/admin/products')
      .send({ title: 'No options', variants: [{ sku: sku('A') }, { sku: sku('B') }] });
    expect(res.status).toBe(400);
  });
});

describe('status, publication and storefront visibility (C-03, C-09)', () => {
  it('runs the full lifecycle with guards, audit and outbox events', async () => {
    const channel = await channelOf(northwind);
    const created = await nw
      .post('/v1/admin/products')
      .send({ title: 'Lifecycle lamp', variants: [{ sku: sku('LAMP'), status: 'inactive' }] });
    const id = created.body.id;
    // Draft cannot be published; no active variant cannot be activated.
    expect((await nw.put(`/v1/admin/products/${id}/publications/${channel}`)).body.code).toBe(
      'INVALID_STATE_TRANSITION',
    );
    expect(
      (await nw.patch(`/v1/admin/products/${id}`).send({ version: 0, status: 'active' })).body.code,
    ).toBe('INVALID_STATE_TRANSITION');
    const v = created.body.variants[0];
    await nw
      .patch(`/v1/admin/products/${id}/variants/${v.id}`)
      .send({ version: v.version, status: 'active' });
    const active = await nw.patch(`/v1/admin/products/${id}`).send({ version: 0, status: 'active' });
    expect(active.status).toBe(200);
    // Last active variant of an active product cannot be deactivated.
    const v2 = active.body.variants[0];
    expect(
      (
        await nw
          .patch(`/v1/admin/products/${id}/variants/${v2.id}`)
          .send({ version: v2.version, status: 'inactive' })
      ).body.code,
    ).toBe('INVALID_STATE_TRANSITION');

    const sf = () =>
      request(app.getHttpServer())
        .get('/v1/storefront/catalog/products/lifecycle-lamp')
        .set('Host', 'northwind.localhost');
    expect((await sf()).status).toBe(404); // active but not published
    const pub = await nw.put(`/v1/admin/products/${id}/publications/${channel}`);
    expect(pub.status).toBe(200);
    expect(pub.body.items.find((p: { channelId: string }) => p.channelId === channel).status).toBe(
      'published',
    );
    // Publishing again is an idempotent no-op (no second event).
    await nw.put(`/v1/admin/products/${id}/publications/${channel}`);
    const visible = await sf();
    expect(visible.status).toBe(200);
    expect(visible.body).toMatchObject({
      slug: 'lifecycle-lamp',
      title: 'Lifecycle lamp',
      variants: [{ sku: v.sku }],
    });
    expect(visible.body).not.toHaveProperty('id');
    // Another tenant's storefront never shows it.
    expect(
      (
        await request(app.getHttpServer())
          .get('/v1/storefront/catalog/products/lifecycle-lamp')
          .set('Host', 'lumiere.localhost')
      ).status,
    ).toBe(404);

    const archived = await nw
      .patch(`/v1/admin/products/${id}`)
      .send({ version: active.body.version, status: 'archived' });
    expect(archived.body.publications.every((p: { status: string }) => p.status === 'unpublished')).toBe(
      true,
    );
    expect((await sf()).status).toBe(404);
    expect((await nw.put(`/v1/admin/products/${id}/publications/${channel}`)).body.code).toBe(
      'INVALID_STATE_TRANSITION',
    );
    expect(
      (await nw.patch(`/v1/admin/products/${id}`).send({ version: archived.body.version, status: 'active' }))
        .body.code,
    ).toBe('INVALID_STATE_TRANSITION');

    const events = await ownerPool.query(
      `select event_type from outbox_events where aggregate_id = $1 order by occurred_at`,
      [id],
    );
    expect(events.rows.map((r) => r.event_type)).toEqual(['ProductPublished', 'ProductUnpublished']);
    expect(await auditCount(northwind, 'product.published')).toBeGreaterThan(0);
    expect(await auditCount(northwind, 'product.archived')).toBeGreaterThan(0);
  });
});

describe('optimistic locking (C-04)', () => {
  it('rejects stale product and variant versions', async () => {
    const p = (await nw.post('/v1/admin/products').send(product('Versioned vase'))).body;
    expect((await nw.patch(`/v1/admin/products/${p.id}`).send({ version: 0, title: 'Vase v1' })).status).toBe(
      200,
    );
    expect((await nw.patch(`/v1/admin/products/${p.id}`).send({ version: 0, title: 'Lost' })).body.code).toBe(
      'VERSION_CONFLICT',
    );
    const v = p.variants[0];
    expect(
      (await nw.patch(`/v1/admin/products/${p.id}/variants/${v.id}`).send({ version: 0, title: 'one' }))
        .status,
    ).toBe(200);
    expect(
      (await nw.patch(`/v1/admin/products/${p.id}/variants/${v.id}`).send({ version: 0, title: 'two' })).body
        .code,
    ).toBe('VERSION_CONFLICT');
  });
});

describe('media (C-07)', () => {
  it('stores sniffed images per tenant and serves them only within scope', async () => {
    const p = (await nw.post('/v1/admin/products').send(product('Pictured plate'))).body;
    const up = await nw
      .post(`/v1/admin/products/${p.id}/media`)
      .attach('file', PNG, { filename: '../../etc/evil name.png', contentType: 'text/html' });
    expect(up.status).toBe(201);
    const media = up.body.media[0];
    expect(media).toMatchObject({
      contentType: 'image/png',
      byteSize: PNG.length,
      filename: 'evil name.png',
    });
    const bytes = await nw.agent.get(`${media.url}`).buffer(true);
    expect(bytes.status).toBe(200);
    expect(bytes.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(bytes.body as Buffer, PNG)).toBe(0);
    // Another tenant cannot fetch it even with its own valid membership.
    const foreign = await au.agent.get(`/v1/admin/media/${media.id}/content?tenantId=${aurum}`);
    expect(foreign.status).toBe(404);
    // Naming a tenant you do not belong to fails membership.
    expect((await au.agent.get(`/v1/admin/media/${media.id}/content?tenantId=${northwind}`)).status).toBe(
      403,
    );
    // Storefront serves it only once the product is visible.
    const sf = () =>
      request(app.getHttpServer()).get(`/v1/storefront/media/${media.id}`).set('Host', 'northwind.localhost');
    expect((await sf()).status).toBe(404);
    const act = await nw.patch(`/v1/admin/products/${p.id}`).send({ version: 0, status: 'active' });
    await nw.put(`/v1/admin/products/${p.id}/publications/${await channelOf(northwind)}`);
    expect((await sf()).status).toBe(200);
    expect(act.status).toBe(200);
    // Alt text + removal.
    const alt = await nw
      .patch(`/v1/admin/products/${p.id}/media`)
      .send({ items: [{ mediaId: media.id, altText: 'White plate' }] });
    expect(alt.body.media[0].altText).toBe('White plate');
    const removed = await nw.del(`/v1/admin/products/${p.id}/media/${media.id}`);
    expect(removed.body.media).toHaveLength(0);
    expect((await sf()).status).toBe(404);
  });

  it('rejects non-images (incl. SVG) and oversize files', async () => {
    const p = (await nw.post('/v1/admin/products').send(product('Upload checks'))).body;
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const bad = await nw
      .post(`/v1/admin/products/${p.id}/media`)
      .attach('file', svg, { filename: 'x.png', contentType: 'image/png' });
    expect(bad.status).toBe(415);
    expect(bad.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    const huge = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
    const big = await nw.post(`/v1/admin/products/${p.id}/media`).attach('file', huge, 'big.png');
    expect(big.status).toBe(413);
    const none = await nw.post(`/v1/admin/products/${p.id}/media`);
    expect(none.status).toBe(400);
  });
});

describe('tenant isolation (C-01)', () => {
  it('cannot read, modify, publish or reference another tenant’s catalog', async () => {
    const p = (await au.post('/v1/admin/products').send(product('Aurum secret chain'))).body;
    const cat = (await au.post('/v1/admin/categories').send({ name: 'Aurum chains' })).body;
    expect((await nw.get(`/v1/admin/products/${p.id}`)).status).toBe(404);
    expect((await nw.patch(`/v1/admin/products/${p.id}`).send({ version: 0, title: 'x' })).status).toBe(404);
    expect((await nw.post(`/v1/admin/products/${p.id}/variants`).send({ sku: sku('X') })).status).toBe(404);
    expect(
      (await nw.put(`/v1/admin/products/${p.id}/publications/${await channelOf(northwind)}`)).status,
    ).toBe(404);
    // Own product cannot be published to a foreign channel.
    const own = (await nw.post('/v1/admin/products').send(product('Own item'))).body;
    expect(
      (await nw.put(`/v1/admin/products/${own.id}/publications/${await channelOf(lumiere)}`)).status,
    ).toBe(404);
    // Foreign category id is rejected as unknown.
    expect(
      (await nw.post('/v1/admin/products').send(product('Cat ref', { categoryId: cat.id }))).status,
    ).toBe(400);
    const list = await nw.get('/v1/admin/products?q=secret');
    expect(list.body.items).toHaveLength(0);
    expect(
      (await nw.get(`/v1/admin/categories`)).body.items.some((c: { id: string }) => c.id === cat.id),
    ).toBe(false);
  });

  it('viewer can read but not edit', async () => {
    const viewer = scoped(await login(app, 'viewer@aurum.demo'), aurum);
    expect((await viewer.get('/v1/admin/products')).status).toBe(200);
    expect((await viewer.post('/v1/admin/products').send(product('Nope'))).status).toBe(403);
  });
});

describe('search, filters, sort and pagination', () => {
  it('finds products by title, SKU and collection; pages without gaps', async () => {
    const prefix = `Pager-${Date.now()}`;
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await nw
        .post('/v1/admin/products')
        .send({ title: `${prefix} ${i}`, variants: [{ sku: `${prefix}-sku-${i}` }] });
      ids.push(r.body.id);
    }
    const bySku = await nw.get(`/v1/admin/products?q=${prefix}-sku-3`);
    expect(bySku.body.items.map((p: { id: string }) => p.id)).toEqual([ids[3]]);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await nw.get(
        `/v1/admin/products?q=${prefix}&sort=title&limit=3${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...res.body.items.map((p: { title: string }) => p.title));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...Array(7).keys()].map((i) => `${prefix} ${i}`));
    const col = await nw.post('/v1/admin/collections').send({ title: `${prefix} picks` });
    const set = await nw
      .put(`/v1/admin/collections/${col.body.id}/products`)
      .send({ version: 0, productIds: [ids[5], ids[1]] });
    expect(set.body.products.map((p: { id: string }) => p.id)).toEqual([ids[5], ids[1]]);
    const inCol = await nw.get(`/v1/admin/products?collectionId=${col.body.id}`);
    expect(inCol.body.items).toHaveLength(2);
    const foreign = (await au.post('/v1/admin/products').send(product('Foreign member'))).body;
    expect(
      (
        await nw
          .put(`/v1/admin/collections/${col.body.id}/products`)
          .send({ version: 1, productIds: [foreign.id] })
      ).status,
    ).toBe(400);
  });
});

describe('categories', () => {
  it('prevents cycles and deletion of non-empty categories', async () => {
    const root = (await nw.post('/v1/admin/categories').send({ name: 'Cycle root' })).body;
    const child = (await nw.post('/v1/admin/categories').send({ name: 'Cycle child', parentId: root.id }))
      .body;
    const cycle = await nw.patch(`/v1/admin/categories/${root.id}`).send({ version: 0, parentId: child.id });
    expect(cycle.status).toBe(400);
    expect((await nw.del(`/v1/admin/categories/${root.id}`)).status).toBe(409);
    const tree = (await nw.get('/v1/admin/categories')).body.items.map((c: { slug: string }) => c.slug);
    expect(tree.indexOf('cycle-child')).toBe(tree.indexOf('cycle-root') + 1);
    expect((await nw.del(`/v1/admin/categories/${child.id}`)).status).toBe(204);
  });
});

describe('saved views (C-10)', () => {
  it('are private unless shared and only the owner can change them', async () => {
    const other = await createMember(northwind, ['catalog_editor'], { email: uniqueEmail('views') });
    const editor = scoped(await login(app, other.email), northwind);
    const mine = await nw
      .post('/v1/admin/saved-views')
      .send({ resource: 'products', name: 'Drafts', filters: { status: 'draft', sort: '-updatedAt' } });
    expect(mine.status).toBe(201);
    expect(
      (await editor.get('/v1/admin/saved-views?resource=products')).body.items.some(
        (v: { id: string }) => v.id === mine.body.id,
      ),
    ).toBe(false);
    await nw.patch(`/v1/admin/saved-views/${mine.body.id}`).send({ version: 0, isShared: true });
    const shared = (await editor.get('/v1/admin/saved-views?resource=products')).body.items.find(
      (v: { id: string }) => v.id === mine.body.id,
    );
    expect(shared).toMatchObject({ isOwn: false, isShared: true, ownerEmail: 'owner@northwind.demo' });
    expect(
      (await editor.patch(`/v1/admin/saved-views/${mine.body.id}`).send({ version: 1, name: 'Hijack' }))
        .status,
    ).toBe(404);
    expect((await editor.del(`/v1/admin/saved-views/${mine.body.id}`)).status).toBe(404);
    expect((await nw.del(`/v1/admin/saved-views/${mine.body.id}`)).status).toBe(204);
  });
});

describe('CSV import (C-08)', () => {
  const csv = (rows: string[]) =>
    ['handle,title,status,brand,option1_name,option1_value,sku,barcode', ...rows].join('\r\n');

  it('previews with per-row errors and writes nothing', async () => {
    const before = (
      await ownerPool.query('select count(*)::int n from products where tenant_id = $1', [northwind])
    ).rows[0].n;
    const res = await nw
      .post('/v1/admin/catalog/imports')
      .set('Idempotency-Key', `imp-${Date.now()}`)
      .send({
        filename: 'bad.csv',
        content: csv([
          'mug,Coffee mug,active,Acme,Colour,Red,MUG-RED,',
          'mug,,,,Colour,Blue,MUG-RED,',
          'Bad Handle,X,,,,,OK-1,',
          'plate,Plate,,,,,"bad sku!",',
        ]),
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'previewed', rowCount: 4, errorCount: 4, validCount: 0 });
    const byLine = Object.fromEntries(
      res.body.rows.map((r: { line: number; errors: { field: string }[] }) => [
        r.line,
        r.errors.map((e) => e.field),
      ]),
    );
    expect(byLine[3]).toContain('sku'); // duplicate SKU in file
    expect(byLine[2]).toContain('handle'); // skipped because its sibling row failed
    expect(byLine[4]).toContain('handle');
    expect(byLine[5]).toContain('sku');
    expect(res.body.rows[0].raw.sku).toBe('MUG-RED');
    expect(
      (await ownerPool.query('select count(*)::int n from products where tenant_id = $1', [northwind]))
        .rows[0].n,
    ).toBe(before);
  });

  it('commits atomically once, and re-importing updates instead of duplicating', async () => {
    const tag = Date.now().toString(36);
    const content = csv([
      `jug-${tag},Water jug,active,Acme,Size,1L,JUG-${tag}-1,`,
      `jug-${tag},,,,Size,2L,JUG-${tag}-2,`,
      `cup-${tag},Tea cup,,,,,CUP-${tag},`,
    ]);
    const preview = await nw
      .post('/v1/admin/catalog/imports')
      .set('Idempotency-Key', `imp-a-${tag}`)
      .send({ filename: 'good.csv', content });
    expect(preview.body).toMatchObject({ errorCount: 0, validCount: 3 });
    expect(preview.body.rows.map((r: { action: string }) => r.action)).toEqual([
      'create_product',
      'create_product',
      'create_product',
    ]);
    const commit = await nw.post(`/v1/admin/catalog/imports/${preview.body.id}/commit`);
    expect(commit.status).toBe(200);
    expect(commit.body.summary).toEqual({
      productsCreated: 2,
      productsUpdated: 0,
      variantsCreated: 3,
      variantsUpdated: 0,
    });
    expect((await nw.post(`/v1/admin/catalog/imports/${preview.body.id}/commit`)).body.code).toBe(
      'INVALID_STATE_TRANSITION',
    );
    const jug = (await nw.get(`/v1/admin/products?q=JUG-${tag}`)).body.items[0];
    expect(jug).toMatchObject({ status: 'active', variantCount: 2 });

    const again = await nw
      .post('/v1/admin/catalog/imports')
      .set('Idempotency-Key', `imp-b-${tag}`)
      .send({ filename: 'good.csv', content });
    expect(
      again.body.rows.map((r: { action: string; variantAction: string }) => `${r.action}:${r.variantAction}`),
    ).toEqual(['update_product:update', 'update_product:update', 'update_product:update']);
    const second = await nw.post(`/v1/admin/catalog/imports/${again.body.id}/commit`);
    expect(second.body.summary).toEqual({
      productsCreated: 0,
      productsUpdated: 2,
      variantsCreated: 0,
      variantsUpdated: 3,
    });
    const count = await ownerPool.query(
      `select count(*)::int n from variants where tenant_id = $1 and sku like $2`,
      [northwind, `%-${tag}%`],
    );
    expect(count.rows[0].n).toBe(3);
    expect(await auditCount(northwind, 'catalog.import_committed')).toBeGreaterThanOrEqual(2);
  });

  it('refuses to commit when data changed after the preview', async () => {
    const tag = `chg${Date.now().toString(36)}`;
    const preview = await nw
      .post('/v1/admin/catalog/imports')
      .set('Idempotency-Key', `imp-c-${tag}`)
      .send({ filename: 'race.csv', content: csv([`race-${tag},Race item,,,,,RACE-${tag},`]) });
    // Someone creates that SKU on another product meanwhile.
    await nw.post('/v1/admin/products').send({ title: `Other ${tag}`, variants: [{ sku: `RACE-${tag}` }] });
    const commit = await nw.post(`/v1/admin/catalog/imports/${preview.body.id}/commit`);
    expect(commit.status).toBe(409);
    expect((await nw.get(`/v1/admin/catalog/imports/${preview.body.id}`)).body.status).toBe('previewed');
  });

  it('rejects unknown columns and oversized files; replays by Idempotency-Key', async () => {
    const unknown = await nw
      .post('/v1/admin/catalog/imports')
      .set('Idempotency-Key', `imp-d-${Date.now()}`)
      .send({ filename: 'x.csv', content: 'handle,sku,price\na,b,1' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.details[0].message).toMatch(/Unknown columns: price/);
    const rows = Array.from({ length: 1001 }, (_, i) => `h${i},T,,,,,S-${i},`);
    const big = await nw
      .post('/v1/admin/catalog/imports')
      .set('Idempotency-Key', `imp-e-${Date.now()}`)
      .send({ filename: 'big.csv', content: csv(rows) });
    expect(big.status).toBe(413);
    const key = `imp-f-${Date.now()}`;
    const body = {
      filename: 'r.csv',
      content: csv([`replay-${Date.now()},Replay,,,,,REPLAY-${Date.now()},`]),
    };
    const a = await nw.post('/v1/admin/catalog/imports').set('Idempotency-Key', key).send(body);
    const b = await nw.post('/v1/admin/catalog/imports').set('Idempotency-Key', key).send(body);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.id).toBe(a.body.id);
  });
});

describe('storefront catalog listing', () => {
  it('lists only visible products, filterable by category, with no internal ids', async () => {
    const channel = await channelOf(northwind);
    const cat = (await nw.post('/v1/admin/categories').send({ name: `Garden ${Date.now()}` })).body;
    const p = (await nw.post('/v1/admin/products').send(product('Watering can', { categoryId: cat.id })))
      .body;
    await nw.patch(`/v1/admin/products/${p.id}`).send({ version: 0, status: 'active' });
    await nw.put(`/v1/admin/products/${p.id}/publications/${channel}`);
    const sf = (q: string) =>
      request(app.getHttpServer())
        .get(`/v1/storefront/catalog/products${q}`)
        .set('Host', 'northwind.localhost');
    const res = await sf(`?category=${cat.slug}`);
    expect(res.body.items).toEqual([
      { slug: 'watering-can', title: 'Watering can', brand: null, productType: 'standard', image: null },
    ]);
    expect((await sf('?category=does-not-exist')).status).toBe(404);
    const cats = await request(app.getHttpServer())
      .get('/v1/storefront/catalog/categories')
      .set('Host', 'northwind.localhost');
    expect(cats.body.items.some((c: { slug: string }) => c.slug === cat.slug)).toBe(true);
    expect(
      (
        await request(app.getHttpServer())
          .get('/v1/storefront/catalog/products')
          .set('Host', 'nobody.localhost')
      ).status,
    ).toBe(404);
  });
});

describe('request size limits', () => {
  it('oversized JSON bodies get the standard 413 error envelope', async () => {
    const res = await nw
      .post('/v1/admin/catalog/imports')
      .set('Idempotency-Key', `huge-${Date.now()}`)
      .send({ filename: 'huge.csv', content: 'x'.repeat(3_000_000) });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', correlationId: expect.any(String) });
  });
});

describe('malformed bodies', () => {
  it('invalid JSON is a 400 with the standard envelope, not a 500', async () => {
    const res = await nw
      .post('/v1/admin/products')
      .set('Content-Type', 'application/json')
      .send('{"title": ');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', correlationId: expect.any(String) });
  });
});
