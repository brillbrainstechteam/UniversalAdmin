import type { INestApplication } from '@nestjs/common';
import { ALL_TENANT_PERMISSIONS, SYSTEM_ROLES } from '@uc/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditCount, createMember, CSRF, login, ownerPool, startApp, tenantId, type Agent } from '../helpers';

let app: INestApplication;
let aurum: string;
let lumiere: string;
let northwind: string;

function scoped(agent: Agent, tenant: string) {
  return {
    get: (p: string) => agent.get(p).set('x-tenant-id', tenant),
    post: (p: string) => agent.post(p).set('x-tenant-id', tenant).set(CSRF),
    patch: (p: string) => agent.patch(p).set('x-tenant-id', tenant).set(CSRF),
    put: (p: string) => agent.put(p).set('x-tenant-id', tenant).set(CSRF),
  };
}
type Client = ReturnType<typeof scoped>;
let au: Client;
let purity22: string;
let purity18: string;
let product: { id: string; variants: { id: string; sku: string }[] };
let seq = 0;
const tag = (p = 'T') => `${p}-${Date.now().toString(36)}-${++seq}`;
const g = (value: string, unit: 'g' | 'mg' | 'kg' | 'ct' = 'g') => ({ value, unit });

beforeAll(async () => {
  app = await startApp();
  aurum = await tenantId('aurum-wholesale');
  lumiere = await tenantId('lumiere-fine');
  northwind = await tenantId('northwind-general');
  au = scoped(await login(app, 'owner@aurum.demo'), aurum);
  const purities = (await au.get('/v1/admin/jewellery/purities')).body.items as {
    id: string;
    code: string;
  }[];
  purity22 = purities.find((p) => p.code === '22K')!.id;
  purity18 = purities.find((p) => p.code === '18K')!.id;
  product = (
    await au.post('/v1/admin/products').send({
      title: `Test bangle ${Date.now()}`,
      productType: 'jewellery',
      options: [{ name: 'Size', values: ['2.4', '2.6'] }],
      variants: [
        { sku: tag('BNG'), optionValues: { Size: '2.4' } },
        { sku: tag('BNG'), optionValues: { Size: '2.6' } },
      ],
    })
  ).body;
});
afterAll(() => app.close());

const specPath = (v = 0) =>
  `/v1/admin/products/${product.id}/variants/${product.variants[v]!.id}/jewellery-spec`;

describe('variant jewellery spec: units, canonical grams, raw kept apart (J-02)', () => {
  it('converts mg/kg/ct exactly, computes fine with provenance and keeps raw input', async () => {
    const res = await au.put(specPath(0)).send({
      purityId: purity22,
      gross: g('24500', 'mg'),
      net: g('0.0239', 'kg'),
      stone: g('3', 'ct'),
      billingBasis: 'net',
      qtyUnit: 'pair',
      piecesPerUnit: 2,
      components: [{ kind: 'diamond', description: 'Round brilliant', count: 6, weight: g('3', 'ct') }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      metal: 'gold',
      grossG: '24.500000',
      netG: '23.900000',
      stoneG: '0.600000',
      fineG: '21.892000', // 23.9 × 0.916 = 21.8924 → 21.892 (3 dp)
      fineSource: 'computed',
      qtyUnit: 'pair',
      piecesPerUnit: 2,
      version: 0,
    });
    expect(res.body.raw.gross).toEqual({ value: '24500', unit: 'mg' });
    expect(res.body.raw.net).toEqual({ value: '0.0239', unit: 'kg' });
    expect(res.body.components[0]).toMatchObject({ weightG: '0.600000', caratWeight: '3.000000', count: 6 });
    expect(res.body.checks.map((c: { code: string }) => c.code)).toContain('PURITY_UNCONFIRMED');
    expect(res.body.checks.map((c: { code: string }) => c.code)).not.toContain('GROSS_MISMATCH');
    const detail = await au.get(`/v1/admin/products/${product.id}`);
    expect(detail.body.jewellery.specs).toHaveLength(1);
    expect(detail.body.jewellery.specs[0].netG).toBe('23.900000');
  });

  it('requires version to replace, rejects stale versions, carats for metal and net > gross on designs', async () => {
    expect(
      (await au.put(specPath(0)).send({ purityId: purity22, billingBasis: 'gross' })).body.details[0].path,
    ).toBe('version');
    expect(
      (await au.put(specPath(0)).send({ version: 7, purityId: purity22, billingBasis: 'gross' })).body.code,
    ).toBe('VERSION_CONFLICT');
    const ct = await au
      .put(specPath(1))
      .send({ purityId: purity22, gross: g('5', 'ct'), billingBasis: 'gross' });
    expect(ct.status).toBe(400);
    const net = await au
      .put(specPath(1))
      .send({ purityId: purity22, gross: g('4'), net: g('4.1'), billingBasis: 'net' });
    expect(net.body.details[0].path).toBe('net');
  });

  it('flags inconsistent measurements as warnings without overwriting gross', async () => {
    const res = await au.put(specPath(1)).send({
      purityId: purity18,
      gross: g('10.000'),
      net: g('9.000'),
      stone: g('0.500'),
      fine: g('7.000'),
      billingBasis: 'gross',
      components: [{ kind: 'gemstone', count: 1, weight: g('1', 'ct') }],
    });
    expect(res.body.grossG).toBe('10.000000');
    const codes = res.body.checks.map((c: { code: string }) => c.code);
    expect(codes).toEqual(
      expect.arrayContaining(['GROSS_MISMATCH', 'STONE_COMPONENT_MISMATCH', 'FINE_DEVIATION']),
    );
    expect(res.body.fineSource).toBe('entered');
  });

  it('is only for jewellery products of entitled tenants (J-07)', async () => {
    const std = (
      await au
        .post('/v1/admin/products')
        .send({ title: `Standard ${tag()}`, variants: [{ sku: tag('STD') }] })
    ).body;
    const r = await au
      .put(`/v1/admin/products/${std.id}/variants/${std.variants[0].id}/jewellery-spec`)
      .send({ purityId: purity22, billingBasis: 'piece' });
    expect(r.status).toBe(409);
    expect((await au.get(`/v1/admin/products/${std.id}`)).body.jewellery).toBeNull();
    const nw = scoped(await login(app, 'owner@northwind.demo'), northwind);
    expect((await nw.get('/v1/admin/jewellery/settings')).body.code).toBe('FEATURE_NOT_ENTITLED');
    expect((await nw.get('/v1/admin/serial-items')).body.code).toBe('FEATURE_NOT_ENTITLED');
    const nwProduct = (await nw.get('/v1/admin/products?q=Canvas')).body.items[0];
    expect((await nw.get(`/v1/admin/products/${nwProduct.id}`)).body.jewellery).toBeNull();
  });
});

describe('serialized items (J-03, J-06)', () => {
  it('stores three same-design pieces with different actual weights and distinct HUIDs', async () => {
    const variantId = product.variants[0]!.id;
    const t = [tag('PC'), tag('PC'), tag('PC')];
    const res = await au.post('/v1/admin/serial-items/bulk').send({
      variantId,
      items: [
        { serialTag: t[0], huid: 'ab12cd', gross: g('24.512'), net: g('23.904'), stone: g('0.608') },
        { serialTag: t[1], huid: 'AB12CE', gross: g('24.487'), net: g('23.881'), stone: g('0.606') },
        { serialTag: t[2], gross: g('24.533'), net: g('23.921'), stone: g('3.06', 'ct') },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(3);
    expect(res.body.rows.map((r: { grossG: string }) => r.grossG)).toEqual([
      '24.512000',
      '24.487000',
      '24.533000',
    ]);
    expect(res.body.rows.map((r: { fineG: string }) => r.fineG)).toEqual([
      '21.896000',
      '21.875000',
      '21.912000',
    ]);
    const stored = await ownerPool.query(
      'select serial_tag, huid, gross_g, pieces from serial_items where serial_tag = any($1) order by serial_tag',
      [t],
    );
    expect(stored.rows.map((r) => r.huid)).toEqual(['AB12CD', 'AB12CE', null]); // normalised upper-case
    expect(new Set(stored.rows.map((r) => r.gross_g)).size).toBe(3);
    expect(stored.rows.every((r) => r.pieces === 2)).toBe(true); // defaults from spec pieces-per-unit
    const counts = (await au.get(`/v1/admin/products/${product.id}`)).body.jewellery.serialItemCounts;
    expect(counts[variantId]).toBe(3);
  });

  it('never lets two items share a HUID or tag (batch, existing, case-insensitive)', async () => {
    const variantId = product.variants[0]!.id;
    const dupInBatch = await au.post('/v1/admin/serial-items/bulk').send({
      variantId,
      items: [
        { serialTag: tag(), huid: 'ZZ0001', gross: g('1'), net: g('1') },
        { serialTag: tag(), huid: 'zz0001', gross: g('1'), net: g('1') },
      ],
    });
    expect(dupInBatch.status).toBe(400);
    expect(dupInBatch.body.details.map((d: { path: string }) => d.path)).toContain('items.1.huid');
    const existing = await au
      .post('/v1/admin/serial-items')
      .send({ variantId, serialTag: tag(), huid: 'DEMO01', gross: g('1'), net: g('1') });
    expect(existing.body.details[0]).toMatchObject({
      path: 'huid',
      message: expect.stringContaining('already assigned'),
    });
    const tagDup = await au
      .post('/v1/admin/serial-items')
      .send({ variantId, serialTag: 'aur-t-0001', gross: g('1'), net: g('1') });
    expect(tagDup.body.details[0].path).toBe('serialTag');
    const badFormat = await au
      .post('/v1/admin/serial-items')
      .send({ variantId, serialTag: tag(), huid: 'TOO-LONG-HUID', gross: g('1'), net: g('1') });
    expect(badFormat.body.details[0].path).toBe('huid');
  });

  it('quarantines malformed rows: whole batch rejected with per-row paths, nothing written; dry run writes nothing', async () => {
    const variantId = product.variants[0]!.id;
    const before = (
      await ownerPool.query('select count(*)::int n from serial_items where tenant_id = $1', [aurum])
    ).rows[0].n;
    const bad = await au.post('/v1/admin/serial-items/bulk').send({
      variantId,
      items: [
        { serialTag: tag(), gross: g('5'), net: g('4.9') },
        { serialTag: tag(), gross: g('5', 'ct'), net: g('0.0000001', 'kg') },
        { serialTag: tag(), gross: { value: 'abc', unit: 'g' }, net: g('1') },
      ],
    });
    // Stage 1 (schema): malformed numbers are reported per row before any business rule runs.
    expect(bad.status).toBe(400);
    expect(bad.body.details.map((d: { path: string }) => d.path)).toEqual(
      expect.arrayContaining(['items.1.net.value', 'items.2.gross.value']),
    );
    // Stage 2 (measurement rules): well-formed but invalid rows are also reported together.
    const rules = await au.post('/v1/admin/serial-items/bulk').send({
      variantId,
      items: [
        { serialTag: tag(), gross: g('5'), net: g('4.9') },
        { serialTag: tag(), gross: g('5', 'ct'), net: g('1') },
        { serialTag: tag(), gross: g('0.0001', 'mg'), net: g('0') },
      ],
    });
    expect(rules.body.details.map((d: { path: string }) => d.path)).toEqual(
      expect.arrayContaining(['items.1.gross.unit', 'items.2.gross.value']),
    );
    expect(
      (await ownerPool.query('select count(*)::int n from serial_items where tenant_id = $1', [aurum]))
        .rows[0].n,
    ).toBe(before);

    const dry = await au
      .post('/v1/admin/serial-items/bulk')
      .send({ variantId, dryRun: true, items: [{ serialTag: tag(), gross: g('5'), net: g('4.9') }] });
    expect(dry.body).toMatchObject({ dryRun: true, created: 0, rows: [{ id: null, fineG: '4.488000' }] });
    expect(
      (await ownerPool.query('select count(*)::int n from serial_items where tenant_id = $1', [aurum]))
        .rows[0].n,
    ).toBe(before);
  });

  it('searches by tag, HUID and SKU and sorts by exact gross weight', async () => {
    const byHuid = await au.get('/v1/admin/serial-items?q=DEMO02');
    expect(byHuid.body.items.map((i: { serialTag: string }) => i.serialTag)).toEqual(['AUR-T-0002']);
    const sorted = await au.get('/v1/admin/serial-items?q=AUR-T-&sort=grossG');
    expect(sorted.body.items.map((i: { grossG: string }) => i.grossG)).toEqual([
      '4.587000',
      '4.612000',
      '4.634000',
    ]);
  });
});

describe('weight exceptions: maker-checker review (J-04)', () => {
  it('net > gross requires a reason, goes to review, and cannot be approved by its author', async () => {
    const variantId = product.variants[1]!.id;
    const noReason = await au
      .post('/v1/admin/serial-items')
      .send({ variantId, serialTag: tag('EX'), purityId: purity22, gross: g('5.000'), net: g('5.010') });
    expect(noReason.body.details[0].path).toBe('net');
    const created = await au.post('/v1/admin/serial-items').send({
      variantId,
      serialTag: tag('EX'),
      purityId: purity22,
      gross: g('5.000'),
      net: g('5.010'),
      weightExceptionReason: 'Gross measured before final polish (scale log #42)',
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('pending_review');
    expect(created.body.checks.map((c: { code: string }) => c.code)).toContain('NET_EXCEEDS_GROSS');
    const self = await au
      .post(`/v1/admin/serial-items/${created.body.id}/review`)
      .send({ version: 0, decision: 'approve', note: 'Looks fine to me' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SEPARATION_OF_DUTIES');
    const reviewer = await createMember(aurum, ['admin']);
    const rv = scoped(await login(app, reviewer.email), aurum);
    const ok = await rv
      .post(`/v1/admin/serial-items/${created.body.id}/review`)
      .send({ version: 0, decision: 'approve', note: 'Checked scale log #42' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      status: 'active',
      review: { by: reviewer.email, note: 'Checked scale log #42' },
    });
    expect(await auditCount(aurum, 'serial_item.exception_approved')).toBeGreaterThan(0);
    expect(
      (
        await rv
          .post(`/v1/admin/serial-items/${created.body.id}/review`)
          .send({ version: 1, decision: 'approve', note: 'again please' })
      ).body.code,
    ).toBe('INVALID_STATE_TRANSITION');
  });

  it('reviewers without jewellery.review are rejected', async () => {
    const inv = scoped(await login(app, 'stock@aurum.demo'), aurum);
    const item = (await au.get('/v1/admin/serial-items?q=AUR-T-0003')).body.items[0];
    expect(
      (
        await inv
          .post(`/v1/admin/serial-items/${item.id}/review`)
          .send({ version: item.version, decision: 'approve', note: 'nope nope' })
      ).body.code,
    ).toBe('PERMISSION_DENIED');
  });
});

describe('edit policy (J-05)', () => {
  it('requires a reason to correct an active item, audits old/new and keeps the previous values in raw', async () => {
    const item = (
      await au.post('/v1/admin/serial-items').send({
        variantId: product.variants[1]!.id,
        serialTag: tag('ED'),
        purityId: purity22,
        gross: g('6.000'),
        net: g('6.000'),
      })
    ).body;
    const noReason = await au
      .patch(`/v1/admin/serial-items/${item.id}`)
      .send({ version: 0, gross: g('6.010'), net: g('6.010') });
    expect(noReason.body.details[0].path).toBe('reason');
    const ok = await au
      .patch(`/v1/admin/serial-items/${item.id}`)
      .send({ version: 0, gross: g('6.010'), net: g('6.010'), reason: 'Re-weighed on calibrated scale' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      grossG: '6.010000',
      fineG: '5.505000',
      raw: { previous: { grossG: '6.000000' } },
    });
    const audit = await ownerPool.query(
      `select old_values, new_values, reason from audit_events where entity_id = $1 and action = 'serial_item.measurements_corrected'`,
      [item.id],
    );
    expect(audit.rows[0]).toMatchObject({
      old_values: { grossG: '6.000000' },
      new_values: { grossG: '6.010000' },
      reason: 'Re-weighed on calibrated scale',
    });
  });

  it('first HUID needs jewellery.edit; changing an existing HUID needs jewellery.review', async () => {
    const inv = scoped(await login(app, 'stock@aurum.demo'), aurum);
    const item = (
      await au.post('/v1/admin/serial-items').send({
        variantId: product.variants[1]!.id,
        serialTag: tag('HU'),
        purityId: purity22,
        gross: g('2'),
        net: g('2'),
      })
    ).body;
    const first = await inv
      .patch(`/v1/admin/serial-items/${item.id}`)
      .send({ version: 0, huid: 'QW12ER', reason: 'Hallmarked today' });
    expect(first.status).toBe(200);
    const change = await inv
      .patch(`/v1/admin/serial-items/${item.id}`)
      .send({ version: 1, huid: 'QW12ES', reason: 'Typo in HUID' });
    expect(change.body).toMatchObject({
      code: 'PERMISSION_DENIED',
      details: { permission: 'jewellery.review' },
    });
    const owner = await au
      .patch(`/v1/admin/serial-items/${item.id}`)
      .send({ version: 1, huid: 'QW12ES', reason: 'Typo in HUID' });
    expect(owner.body.huid).toBe('QW12ES');
    expect(await auditCount(aurum, 'serial_item.huid_corrected')).toBeGreaterThan(0);
  });

  it('retired items are read-only', async () => {
    const item = (
      await au.post('/v1/admin/serial-items').send({
        variantId: product.variants[1]!.id,
        serialTag: tag('RT'),
        purityId: purity22,
        gross: g('2'),
        net: g('2'),
      })
    ).body;
    const retired = await au
      .patch(`/v1/admin/serial-items/${item.id}`)
      .send({ version: 0, status: 'retired' });
    expect(retired.body.status).toBe('retired');
    expect(
      (
        await au
          .patch(`/v1/admin/serial-items/${item.id}`)
          .send({ version: 1, pieces: 2, reason: 'Trying to edit' })
      ).body.code,
    ).toBe('INVALID_STATE_TRANSITION');
  });

  it('resolving an exception by correcting weights re-activates the item', async () => {
    const item = (
      await au.post('/v1/admin/serial-items').send({
        variantId: product.variants[1]!.id,
        serialTag: tag('FX'),
        purityId: purity22,
        gross: g('3'),
        net: g('3.2'),
        weightExceptionReason: 'Suspected scale error',
      })
    ).body;
    expect(item.status).toBe('pending_review');
    const fixed = await au.patch(`/v1/admin/serial-items/${item.id}`).send({ version: 0, net: g('2.9') });
    expect(fixed.body).toMatchObject({ status: 'active', weightExceptionReason: null });
  });
});

describe('settings and purities', () => {
  it('confirming a purity clears the unconfirmed notice; fineness changes do not rewrite stored fine weights', async () => {
    const item = (await au.get('/v1/admin/serial-items?q=AUR-T-0001')).body.items[0];
    const purity = (await au.get('/v1/admin/jewellery/purities')).body.items.find(
      (p: { code: string }) => p.code === '22K',
    );
    expect(purity.source).toBe('platform_default');
    const confirmed = await au
      .patch(`/v1/admin/jewellery/purities/${purity.id}`)
      .send({ version: purity.version, confirm: true });
    expect(confirmed.body.confirmedAt).not.toBeNull();
    const changed = await au
      .patch(`/v1/admin/jewellery/purities/${purity.id}`)
      .send({ version: confirmed.body.version, fineness: '0.917' });
    expect(changed.body.fineness).toBe('0.917000');
    const again = (await au.get(`/v1/admin/serial-items/${item.id}`)).body;
    expect(again.fineG).toBe(item.fineG); // snapshot preserved
    expect(again.checks.map((c: { code: string }) => c.code)).not.toContain('PURITY_UNCONFIRMED');
    await au
      .patch(`/v1/admin/jewellery/purities/${purity.id}`)
      .send({ version: changed.body.version, fineness: '0.916' });
  });

  it('validates fineness and settings, with optimistic locking', async () => {
    expect(
      (
        await au
          .post('/v1/admin/jewellery/purities')
          .send({ metal: 'gold', code: '23K', label: '23K', fineness: '1.5' })
      ).status,
    ).toBe(400);
    expect(
      (
        await au
          .post('/v1/admin/jewellery/purities')
          .send({ metal: 'gold', code: '22K', label: 'dup', fineness: '0.9' })
      ).body.details.field,
    ).toBe('code');
    const s = (await au.get('/v1/admin/jewellery/settings')).body;
    expect(s).toMatchObject({ weightToleranceG: '0.010000', fineScale: 3, huidFormat: 'bis_6_alnum' });
    expect(
      (await au.put('/v1/admin/jewellery/settings').send({ version: s.version, fineScale: 9 })).status,
    ).toBe(400);
    const ok = await au
      .put('/v1/admin/jewellery/settings')
      .send({ version: s.version, weightToleranceG: '0.005' });
    expect(ok.body.weightToleranceG).toBe('0.005000');
    expect(
      (await au.put('/v1/admin/jewellery/settings').send({ version: s.version, fineScale: 2 })).body.code,
    ).toBe('VERSION_CONFLICT');
    await au
      .put('/v1/admin/jewellery/settings')
      .send({ version: ok.body.version, weightToleranceG: '0.010' });
  });
});

describe('isolation and roles (J-08, J-09)', () => {
  it('another tenant cannot read or modify items, specs or purities', async () => {
    const lu = scoped(await login(app, 'owner@lumiere.demo'), lumiere);
    const item = (await au.get('/v1/admin/serial-items?q=AUR-T-0001')).body.items[0];
    expect((await lu.get(`/v1/admin/serial-items/${item.id}`)).status).toBe(404);
    expect(
      (
        await lu
          .patch(`/v1/admin/serial-items/${item.id}`)
          .send({ version: 0, pieces: 3, reason: 'cross tenant' })
      ).status,
    ).toBe(404);
    expect((await lu.get(specPath(0))).status).toBe(404);
    const luProduct = (await lu.get('/v1/admin/products?q=Solitaire')).body.items[0];
    const luDetail = (await lu.get(`/v1/admin/products/${luProduct.id}`)).body;
    const foreignPurity = await lu
      .put(`/v1/admin/products/${luProduct.id}/variants/${luDetail.variants[0].id}/jewellery-spec`)
      .send({
        version: luDetail.jewellery.specs[0].version,
        purityId: purity22,
        billingBasis: 'net',
      });
    expect(foreignPurity.body.details[0].path).toBe('purityId');
    const list = await lu.get('/v1/admin/serial-items?limit=100');
    expect(list.body.items.every((i: { serialTag: string }) => i.serialTag.startsWith('LUM-'))).toBe(true);
    expect(
      (
        await lu
          .post('/v1/admin/serial-items')
          .send({ variantId: product.variants[0]!.id, serialTag: tag(), gross: g('1'), net: g('1') })
      ).status,
    ).toBe(404);
  });

  it('every tenant’s system roles match the code templates (data migration + provisioning)', async () => {
    const { rows } = await ownerPool.query('select tenant_id, key, permissions from roles where is_system');
    for (const r of rows) {
      const expected = [...(SYSTEM_ROLES[r.key]?.permissions ?? [])].sort();
      expect([...r.permissions].sort(), `${r.key}`).toEqual(expected);
    }
    expect(SYSTEM_ROLES.owner!.permissions).toEqual(ALL_TENANT_PERMISSIONS);
  });

  it('storefront exposes design specs only for visible jewellery products', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/catalog/products/22k-plain-gold-band')
      .set('Host', 'aurum-b2b.localhost');
    expect(res.status).toBe(200);
    const v = res.body.variants.find((x: { sku: string }) => x.sku === 'AUR-BAND22-14');
    expect(v.jewellery).toMatchObject({ metal: 'gold', grossG: '4.600000', qtyUnit: 'piece' });
    expect(v.jewellery).not.toHaveProperty('purityId');
    expect(JSON.stringify(res.body)).not.toContain('DEMO01'); // no per-article data before Phase 04 availability
  });
});
