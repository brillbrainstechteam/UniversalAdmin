import type { INestApplication } from '@nestjs/common';
import { createDb, flagStaleRates, requireEnv, systemTx } from '@uc/db';
import { sql } from 'drizzle-orm';
import Redis from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_REDIS_URL } from '../env';
import {
  auditCount,
  createMember,
  CSRF,
  login,
  ownerPool,
  startApp,
  tenantId,
  TEST_PASSWORD,
  type Agent,
} from '../helpers';

/**
 * Phase 06 acceptance (PR-01 … PR-11). Seeded Aurum rule "Gold jewellery by billing weight (DEMO)":
 * metal = billing-basis (net) weight × 22K rate; making 450/g on the same weight; hallmarking 45 per piece.
 */
let app: INestApplication;
let aurum: string;
let lumiere: string;
let northwind: string;
let p22: string;
let b2bChannel: string;
const worker = createDb(requireEnv('TEST_DATABASE_URL'), { max: 2 });

function scoped(agent: Agent, tenant: string) {
  return {
    get: (p: string) => agent.get(p).set('x-tenant-id', tenant),
    post: (p: string) => agent.post(p).set('x-tenant-id', tenant).set(CSRF),
    put: (p: string) => agent.put(p).set('x-tenant-id', tenant).set(CSRF),
    patch: (p: string) => agent.patch(p).set('x-tenant-id', tenant).set(CSRF),
  };
}
type Client = ReturnType<typeof scoped>;
let au: Client; // owner
let ar: Client; // rate approver (rates.approve, pricing.publish)
let re: Client; // rate editor (rates.edit, pricing.edit)
let av: Client; // viewer
let lu: Client;
let nw: Client;

let seq = 0;
const uid = () => `${Date.now().toString(36)}${++seq}`.toUpperCase();
const one = async <T = Record<string, unknown>>(q: string, params: unknown[]) =>
  (await ownerPool.query(q, params)).rows[0] as T;
const variant = async (tenant: string, sku: string) =>
  (await one<{ id: string }>('select id from variants where tenant_id = $1 and sku = $2', [tenant, sku])).id;
const piece = async (tag: string) =>
  await one<{ id: string; variant_id: string }>(
    'select id, variant_id from serial_items where serial_tag = $1',
    [tag],
  );
const events = async (type: string, id: string) =>
  (
    await one<{ n: number }>(
      'select count(*)::int n from outbox_events where event_type = $1 and aggregate_id = $2',
      [type, id],
    )
  ).n;

/** Proposed by the rate editor, approved by the approver; returns the approved rate. */
async function setRate(value: string, extra: Record<string, unknown> = {}) {
  const p = await re
    .post('/v1/admin/rates')
    .send({ purityId: p22, value, unit: 'per_g', reason: 'Test rate entry', ...extra });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const a = await ar.post(`/v1/admin/rates/${p.body.id}/approve`).send({});
  expect(a.status, JSON.stringify(a.body)).toBe(200);
  return a.body as { id: string; ratePerG: string; isCurrent: boolean; stale: boolean };
}
async function quoteFor(c: Client, lines: unknown[], channelId: string | null = null) {
  return c.post('/v1/admin/pricing/quotes').send({ channelId, lines });
}
const parts = (
  q: { lines: { breakdown: { components: { code: string; amountMinor: string }[] } }[] },
  i = 0,
) => Object.fromEntries(q.lines[i]!.breakdown.components.map((c) => [c.code, c.amountMinor]));

beforeAll(async () => {
  app = await startApp();
  aurum = await tenantId('aurum-wholesale');
  lumiere = await tenantId('lumiere-fine');
  northwind = await tenantId('northwind-general');
  p22 = (
    await one<{ id: string }>("select id from purity_definitions where tenant_id = $1 and code = '22K'", [
      aurum,
    ])
  ).id;
  b2bChannel = (
    await one<{ id: string }>("select id from channels where tenant_id = $1 and code = 'b2b-web'", [aurum])
  ).id;
  au = scoped(await login(app, 'owner@aurum.demo'), aurum);
  ar = scoped(await login(app, 'rates@aurum.demo'), aurum);
  av = scoped(await login(app, 'viewer@aurum.demo'), aurum);
  const editor = await createMember(aurum, ['rate_editor']);
  re = scoped(await login(app, editor.email, 'merchant', TEST_PASSWORD), aurum);
  lu = scoped(await login(app, 'owner@lumiere.demo'), lumiere);
  nw = scoped(await login(app, 'owner@northwind.demo'), northwind);
});
afterAll(async () => {
  await app.close();
  await worker.close();
});

describe('metal rates: units, maker-checker, history (PR-01, PR-02)', () => {
  it('converts per 10 g exactly and rejects over-precise or foreign input', async () => {
    const r = await re
      .post('/v1/admin/rates')
      .send({ purityId: p22, value: '66600', unit: 'per_10g', reason: 'Unit test' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      ratePerG: '6660.000000',
      status: 'proposed',
      input: { value: '66600', unit: 'per_10g' },
      isCurrent: false,
    });
    const precise = await re
      .post('/v1/admin/rates')
      .send({ purityId: p22, value: '0.000001', unit: 'per_kg', reason: 'Too precise' });
    expect(precise.status).toBe(400);
    expect(precise.body.message).toMatch(/more precise/);
    const lumPurity = (
      await one<{ id: string }>("select id from purity_definitions where tenant_id = $1 and code = '18K'", [
        lumiere,
      ])
    ).id;
    expect(
      (
        await re
          .post('/v1/admin/rates')
          .send({ purityId: lumPurity, value: '1', unit: 'per_g', reason: 'Other tenant' })
      ).status,
    ).toBe(404);
    expect(
      (await re.post('/v1/admin/rates').send({ purityId: p22, value: '1', unit: 'per_g', reason: 'x' }))
        .status,
    ).toBe(400); // reason too short
    await ar.post(`/v1/admin/rates/${r.body.id}/reject`).send({ reason: 'Only testing units' }).expect(200);
  });

  it('the proposer cannot approve; a different approver publishes; values are immutable', async () => {
    const own = await au
      .post('/v1/admin/rates')
      .send({ purityId: p22, value: '6010', unit: 'per_g', reason: 'Owner proposal' });
    expect(own.status).toBe(201);
    const self = await au.post(`/v1/admin/rates/${own.body.id}/approve`).send({});
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SEPARATION_OF_DUTIES');
    // An editor without rates.approve cannot approve at all.
    expect((await re.post(`/v1/admin/rates/${own.body.id}/approve`).send({})).body.code).toBe(
      'PERMISSION_DENIED',
    );
    const ok = await ar
      .post(`/v1/admin/rates/${own.body.id}/approve`)
      .send({ note: 'Checked against board rate' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      status: 'approved',
      isCurrent: true,
      decidedBy: { name: expect.stringMatching(/Ravi/) },
    });
    expect(await events('RateApproved', own.body.id)).toBe(1);
    expect(await events('RatePublished', own.body.id)).toBe(1);
    expect(await auditCount(aurum, 'rates.approved')).toBeGreaterThan(0);
    expect((await ar.post(`/v1/admin/rates/${own.body.id}/approve`).send({})).body.code).toBe(
      'INVALID_STATE_TRANSITION',
    );
    // Database backstops: immutable values and four-eyes CHECK, even for the table owner.
    await expect(
      ownerPool.query('update metal_rates set rate_per_g = 1 where id = $1', [own.body.id]),
    ).rejects.toThrow(/immutable/);
    const pending = await au
      .post('/v1/admin/rates')
      .send({ purityId: p22, value: '6020', unit: 'per_g', reason: 'Self-approve attempt' });
    await expect(
      ownerPool.query(
        "update metal_rates set status = 'approved', decided_by = proposed_by, decided_at = now(), effective_from = now() where id = $1",
        [pending.body.id],
      ),
    ).rejects.toThrow(/four_eyes/);
    const denied = await systemTx(worker.db, (tx) =>
      tx.execute(sql`delete from metal_rates where id = ${own.body.id}`),
    ).catch((e: unknown) => e);
    expect(String((denied as { cause?: Error }).cause?.message)).toMatch(/permission denied/);
    await ar.post(`/v1/admin/rates/${pending.body.id}/reject`).send({ reason: 'Not needed' }).expect(200);
  });

  it('keeps history; "rollback" is a new approved revision of the old value', async () => {
    const a = await setRate('6200');
    const b = await setRate('6300');
    const back = await setRate('6200');
    const current = await au.get('/v1/admin/rates/current');
    const row = current.body.items.find((i: { purity: { id: string } }) => i.purity.id === p22);
    expect(row.rate.id).toBe(back.id);
    expect(row.rate.ratePerG).toBe('6200.000000');
    const hist = await au.get(`/v1/admin/rates?purityId=${p22}&status=approved&limit=100`);
    const ids = hist.body.items.map((r: { id: string }) => r.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id, back.id]));
    expect(hist.body.items.filter((r: { isCurrent: boolean }) => r.isCurrent)).toHaveLength(1);
  });
});

describe('quotes on real items (PR-04, PR-05, PR-09)', () => {
  it('prices pieces on their own actual weights, exactly', async () => {
    await setRate('6000');
    const t1 = await piece('AUR-T-0001');
    const t2 = await piece('AUR-T-0002');
    const q = await quoteFor(au, [
      { variantId: t1.variant_id, serialItemId: t1.id },
      { variantId: t2.variant_id, serialItemId: t2.id },
    ]);
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    // 4.612 g × 6000 = 27672.00 ; 4.612 × 450 = 2075.40 ; hallmark 45
    expect(parts(q.body, 0)).toEqual({ metal: '2767200', making: '207540', charge_1_hallmark: '4500' });
    // 4.587 g × 6000 = 27522.00 ; 4.587 × 450 = 2064.15
    expect(parts(q.body, 1)).toEqual({ metal: '2752200', making: '206415', charge_1_hallmark: '4500' });
    expect(q.body.lines[0].breakdown.totalMinor).toBe('2979240');
    expect(q.body.lines[1].breakdown.totalMinor).toBe('2963115');
    expect(q.body.totalMinor).toBe('5942355');
    expect(q.body.lines[0]).toMatchObject({
      serialTag: 'AUR-T-0001',
      measurements: { netG: '4.612000', billingBasis: 'net' },
      rate: { ratePerG: '6000.000000', stale: false, simulated: false },
    });
    expect(q.body.status).toBe('active');
    expect(new Date(q.body.expiresAt).getTime() - new Date(q.body.createdAt).getTime()).toBe(15 * 60_000);
  });

  it('prices a design by its spec weight × quantity, and refuses duplicates or pieces under review', async () => {
    const v = await variant(aurum, 'AUR-BAND22-14');
    const q = await quoteFor(au, [{ variantId: v, quantity: 3 }]);
    expect(q.status).toBe(201);
    expect(parts(q.body)).toEqual({ metal: '8280000', making: '621000', charge_1_hallmark: '13500' });
    const t1 = await piece('AUR-T-0001');
    const dup = await quoteFor(au, [
      { variantId: t1.variant_id, serialItemId: t1.id },
      { variantId: t1.variant_id, serialItemId: t1.id },
    ]);
    expect(dup.status).toBe(422);
    expect(
      (await quoteFor(au, [{ variantId: t1.variant_id, serialItemId: t1.id, quantity: 2 }])).status,
    ).toBe(400);
    const t3 = await piece('AUR-T-0003');
    await ownerPool.query("update serial_items set status = 'pending_review' where id = $1", [t3.id]);
    try {
      const r = await quoteFor(au, [{ variantId: t3.variant_id, serialItemId: t3.id }]);
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({
        code: 'PRICE_INPUT_INVALID',
        message: expect.stringMatching(/under review/),
      });
    } finally {
      await ownerPool.query("update serial_items set status = 'active' where id = $1", [t3.id]);
    }
  });

  it('a product no rule covers is refused with PRICE_RULE_MISSING', async () => {
    const sku = `STD-${uid()}`;
    const p = await au
      .post('/v1/admin/products')
      .send({ title: `Standard ${sku}`, productType: 'standard', variants: [{ sku }] });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const r = await quoteFor(au, [{ variantId: await variant(aurum, sku) }]);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('PRICE_RULE_MISSING');
  });
});

describe('quote TTL and revalidation (PR-08)', () => {
  it('unchanged keeps the quote; a new rate supersedes it while the original stays as shown', async () => {
    await setRate('6000');
    const t1 = await piece('AUR-T-0001');
    const q = (await quoteFor(au, [{ variantId: t1.variant_id, serialItemId: t1.id }])).body;
    const same = await au.post(`/v1/admin/pricing/quotes/${q.id}/revalidate`).send({});
    expect(same.body).toMatchObject({ status: 'unchanged', quote: { id: q.id } });

    await setRate('6100');
    const changed = await au.post(`/v1/admin/pricing/quotes/${q.id}/revalidate`).send({});
    expect(changed.body).toMatchObject({
      status: 'changed',
      previousTotalMinor: '2979240',
      newTotalMinor: '3025360',
    });
    expect(changed.body.quote.id).not.toBe(q.id);
    const old = (await au.get(`/v1/admin/pricing/quotes/${q.id}`)).body;
    expect(old).toMatchObject({
      status: 'superseded',
      supersededBy: changed.body.quote.id,
      totalMinor: '2979240',
    });
    expect(old.lines[0].rate.ratePerG).toBe('6000.000000');
    expect((await au.post(`/v1/admin/pricing/quotes/${q.id}/revalidate`).send({})).status).toBe(409);
    await expect(
      ownerPool.query('update price_quotes set total_minor = 1 where id = $1', [q.id]),
    ).rejects.toThrow(/immutable/);
  });

  it('an expired quote with the same price is re-issued with a new expiry; a failing item is "unavailable"', async () => {
    const t1 = await piece('AUR-T-0001');
    const q = (await quoteFor(au, [{ variantId: t1.variant_id, serialItemId: t1.id }])).body;
    await ownerPool.query('alter table price_quotes disable trigger price_quotes_guard');
    try {
      await ownerPool.query(
        "update price_quotes set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = $1",
        [q.id],
      );
    } finally {
      await ownerPool.query('alter table price_quotes enable trigger price_quotes_guard');
    }
    expect((await au.get(`/v1/admin/pricing/quotes/${q.id}`)).body.status).toBe('expired');
    const listed = await au.get('/v1/admin/pricing/quotes?status=expired');
    expect(listed.body.items.map((x: { id: string }) => x.id)).toContain(q.id);
    const r = await au.post(`/v1/admin/pricing/quotes/${q.id}/revalidate`).send({});
    expect(r.body.status).toBe('unchanged');
    expect(r.body.quote.id).not.toBe(q.id);
    expect(r.body.quote.status).toBe('active');

    const t3 = await piece('AUR-T-0003');
    const q3 = (await quoteFor(au, [{ variantId: t3.variant_id, serialItemId: t3.id }])).body;
    await ownerPool.query("update serial_items set status = 'pending_review' where id = $1", [t3.id]);
    try {
      const u = await au.post(`/v1/admin/pricing/quotes/${q3.id}/revalidate`).send({});
      expect(u.body).toMatchObject({
        status: 'unavailable',
        quote: { id: q3.id },
        problems: [{ code: 'PRICE_INPUT_INVALID' }],
      });
    } finally {
      await ownerPool.query("update serial_items set status = 'active' where id = $1", [t3.id]);
    }
  });
});

describe('freshness policy (PR-03)', () => {
  it('blocks stale rates by default, allows them flagged under use_last_approved, and emits RateStale once', async () => {
    const stale = await setRate('6000', {
      sourceAsOf: new Date(Date.now() - 2 * 24 * 3600_000).toISOString(),
    });
    expect(stale.stale).toBe(true);
    const t1 = await piece('AUR-T-0001');
    const blocked = await quoteFor(au, [{ variantId: t1.variant_id, serialItemId: t1.id }]);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('RATE_STALE');

    const s = (await au.get('/v1/admin/pricing/settings')).body;
    await au
      .put('/v1/admin/pricing/settings')
      .send({ version: s.version, stalePolicy: 'use_last_approved' })
      .expect(200);
    try {
      const ok = await quoteFor(au, [{ variantId: t1.variant_id, serialItemId: t1.id }]);
      expect(ok.status).toBe(201);
      expect(ok.body.lines[0].rate.stale).toBe(true);
      expect(ok.body.warnings.join(' ')).toMatch(/stale/);
      expect(await systemTx(worker.db, (tx) => flagStaleRates(tx))).toBeGreaterThanOrEqual(1);
      expect(await systemTx(worker.db, (tx) => flagStaleRates(tx))).toBe(0);
      expect(await events('RateStale', stale.id)).toBe(1);
    } finally {
      const s2 = (await au.get('/v1/admin/pricing/settings')).body;
      await au
        .put('/v1/admin/pricing/settings')
        .send({ version: s2.version, stalePolicy: 'block' })
        .expect(200);
      await setRate('6000');
    }
  });

  it('the simulator proposes clearly labelled values that still need approval', async () => {
    const src = await re
      .post('/v1/admin/rates/sources')
      .send({ providerKey: 'simulator', name: `Simulator ${uid()}` });
    expect(src.status, JSON.stringify(src.body)).toBe(201);
    expect(src.body.simulated).toBe(true);
    expect(
      (await re.post('/v1/admin/rates/sources').send({ providerKey: 'licensed_feed', name: `Feed ${uid()}` }))
        .body.code,
    ).toBe('CONNECTOR_UNAVAILABLE');
    expect(
      (
        await re
          .post('/v1/admin/rates/sources')
          .send({ providerKey: 'simulator', name: `Sim ${uid()}`, credentialRef: 'plain-secret' })
      ).status,
    ).toBe(400);
    const pulled = await re.post(`/v1/admin/rates/sources/${src.body.id}/pull`).send({});
    expect(pulled.status).toBe(200);
    const sim22 = pulled.body.proposed.find((r: { purity: { code: string } }) => r.purity.code === '22K');
    expect(sim22).toMatchObject({
      status: 'proposed',
      ratePerG: '6595.200000',
      source: { simulated: true },
      reason: expect.stringMatching(/SIMULATED/),
    }); // 7200 × 0.916
    const again = await re.post(`/v1/admin/rates/sources/${src.body.id}/pull`).send({});
    expect(again.body.proposed).toHaveLength(0);
    expect(again.body.skipped.length).toBeGreaterThan(0);
    for (const r of pulled.body.proposed)
      await ar.post(`/v1/admin/rates/${r.id}/reject`).send({ reason: 'Simulator check only' }).expect(200);
  });
});

describe('rule versions, review, conflicts and precedence (PR-06, PR-07)', () => {
  let book: string;
  let rule: string;
  let v1Quote: string;
  const def = (making: string, extra: Record<string, unknown> = {}) => ({
    base: { kind: 'metal', weightBasis: 'gross' },
    making: { mode: 'per_piece', amount: making },
    ...extra,
  });

  it('drafts are published by someone else; a channel-specific book wins for that channel', async () => {
    const b = await re
      .post('/v1/admin/pricing/books')
      .send({ name: `B2B book ${uid()}`, channelId: b2bChannel });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    book = b.body.id;
    const r = await re.post('/v1/admin/pricing/rules').send({
      bookId: book,
      name: 'Gold per piece',
      priority: 5,
      conditions: { metals: ['gold'] },
      definition: def('1000'),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    rule = r.body.id;
    const draft = r.body.draft;
    expect(draft).toMatchObject({ version: 1, status: 'draft' });
    expect(
      (await re.post(`/v1/admin/pricing/rules/${rule}/publish`).send({ versionId: draft.id })).body.code,
    ).toBe('PERMISSION_DENIED');
    const pub = await ar.post(`/v1/admin/pricing/rules/${rule}/publish`).send({ versionId: draft.id });
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    expect(pub.body).toMatchObject({ status: 'published', published: { version: 1 } });
    expect(await events('PriceRulePublished', rule)).toBe(1);

    const t1 = await piece('AUR-T-0001');
    const q = await quoteFor(au, [{ variantId: t1.variant_id, serialItemId: t1.id }], b2bChannel);
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    expect(q.body.lines[0]).toMatchObject({ book: { id: book }, rule: { id: rule, version: 1 } });
    expect(q.body.totalMinor).toBe('2867200'); // 4.612 gross × 6000 + 1000 per piece
    v1Quote = q.body.id;
    const general = await quoteFor(au, [{ variantId: t1.variant_id, serialItemId: t1.id }]);
    expect(general.body.lines[0].book.id).not.toBe(book);
  });

  it('review: the author of a draft cannot publish it; publishing supersedes and old quotes keep v1', async () => {
    const tax = await au
      .post('/v1/admin/pricing/tax-rules')
      .send({ label: 'Test tax on making', ratePercent: '3', appliesTo: ['making'] });
    expect(tax.status).toBe(201);
    expect(tax.body.status).toBe('pending_validation');
    expect(
      (
        await au
          .patch(`/v1/admin/pricing/tax-rules/${tax.body.id}`)
          .send({ version: tax.body.version, status: 'validated' })
      ).status,
    ).toBe(400);
    const saved = await au.put(`/v1/admin/pricing/rules/${rule}/draft`).send({
      priority: 5,
      conditions: { metals: ['gold'] },
      definition: def('2000', { taxRuleId: tax.body.id }),
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const v2 = saved.body.draft;
    expect(v2.version).toBe(2);
    const self = await au.post(`/v1/admin/pricing/rules/${rule}/publish`).send({ versionId: v2.id });
    expect(self.body.code).toBe('SEPARATION_OF_DUTIES');
    expect(
      (await ar.post(`/v1/admin/pricing/rules/${rule}/publish`).send({ versionId: v2.id })).body.published
        .version,
    ).toBe(2);
    const detail = (await au.get(`/v1/admin/pricing/rules/${rule}`)).body;
    expect(
      detail.versions.map((v: { version: number; status: string }) => `${v.version}:${v.status}`),
    ).toEqual(['2:published', '1:superseded']);

    const t1 = await piece('AUR-T-0001');
    const q = await quoteFor(au, [{ variantId: t1.variant_id, serialItemId: t1.id }], b2bChannel);
    // metal 2767200 + making 200000 + 3% tax on making (6000)
    expect(q.body).toMatchObject({ totalMinor: '2973200', taxMinor: '6000' });
    expect(q.body.warnings.join(' ')).toMatch(/pending accountant validation/);
    const old = (await au.get(`/v1/admin/pricing/quotes/${v1Quote}`)).body;
    expect(old).toMatchObject({ totalMinor: '2867200', lines: [{ rule: { version: 1 } }] });
    await expect(
      ownerPool.query(
        `update price_rule_versions set definition = '{}'::jsonb where rule_id = $1 and version = 2`,
        [rule],
      ),
    ).rejects.toThrow(/immutable/);
  });

  it('detects conflicts; a book with no matching rule falls through to the next', async () => {
    const r2 = await re
      .post('/v1/admin/pricing/rules')
      .send({ bookId: book, name: 'Catch-all', priority: 5, conditions: {}, definition: def('1') });
    const clash = await ar
      .post(`/v1/admin/pricing/rules/${r2.body.id}/publish`)
      .send({ versionId: r2.body.draft.id });
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({ code: 'RULE_CONFLICT', details: { rules: [{ id: rule }] } });
    const lower = await re
      .put(`/v1/admin/pricing/rules/${r2.body.id}/draft`)
      .send({ lockVersion: r2.body.draft.lockVersion, priority: 4, conditions: {}, definition: def('1') });
    expect(
      (
        await ar
          .post(`/v1/admin/pricing/rules/${r2.body.id}/publish`)
          .send({ versionId: lower.body.draft.id })
      ).status,
    ).toBe(200);

    const silverBook = await re
      .post('/v1/admin/pricing/books')
      .send({ name: `Silver only ${uid()}`, channelId: b2bChannel, priority: 100 });
    const sr = await re.post('/v1/admin/pricing/rules').send({
      bookId: silverBook.body.id,
      name: 'Silver',
      priority: 1,
      conditions: { metals: ['silver'] },
      definition: def('5'),
    });
    await ar
      .post(`/v1/admin/pricing/rules/${sr.body.id}/publish`)
      .send({ versionId: sr.body.draft.id })
      .expect(200);
    const t1 = await piece('AUR-T-0001');
    const q = await quoteFor(au, [{ variantId: t1.variant_id, serialItemId: t1.id }], b2bChannel);
    expect(q.body.lines[0]).toMatchObject({ book: { id: book }, rule: { id: rule } });
  });

  it('the calculator tests a draft on manual measurements without storing anything', async () => {
    const d = await re.put(`/v1/admin/pricing/rules/${rule}/draft`).send({
      priority: 5,
      conditions: { metals: ['gold'] },
      definition: {
        base: { kind: 'metal', weightBasis: 'net' },
        making: { mode: 'per_gram', amount: '100' },
        wastage: { percent: '2' },
      },
    });
    const before = (
      await one<{ n: number }>('select count(*)::int n from price_quotes where tenant_id = $1', [aurum])
    ).n;
    const c = await au.post('/v1/admin/pricing/calculate').send({
      ruleVersionId: d.body.draft.id,
      manual: { purityId: p22, grossG: '10', netG: '9', billingBasis: 'net' },
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.persisted).toBe(false);
    // 9 g × 6000 = 54000 ; making 900 ; wastage 0.18 g × 6000 = 1080
    expect(
      Object.fromEntries(
        c.body.line.breakdown.components.map((x: { code: string; amountMinor: string }) => [
          x.code,
          x.amountMinor,
        ]),
      ),
    ).toEqual({
      metal: '5400000',
      making: '90000',
      wastage: '108000',
    });
    expect(c.body.line.rule).toMatchObject({ status: 'draft' });
    expect(
      (await one<{ n: number }>('select count(*)::int n from price_quotes where tenant_id = $1', [aurum])).n,
    ).toBe(before);
    expect((await au.post('/v1/admin/pricing/calculate').send({ manual: { purityId: p22 } })).status).toBe(
      400,
    );
  });
});

describe('general commerce list prices (PR-10)', () => {
  it('prices from the price book without any metal rate; metal rates are not entitled', async () => {
    const mug = await variant(northwind, 'NW-MUG-01');
    const q = await quoteFor(nw, [{ variantId: mug, quantity: 2 }]);
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    expect(q.body).toMatchObject({ currency: 'GBP', totalMinor: '1900', lines: [{ rate: null }] });
    expect((await nw.get('/v1/admin/rates/current')).body.code).toBe('FEATURE_NOT_ENTITLED');
    const books = (await nw.get('/v1/admin/pricing/books')).body.items;
    const put = await nw
      .put(`/v1/admin/pricing/books/${books[0].id}/list-prices`)
      .send({ items: [{ variantId: mug, amount: '10.25' }] });
    expect(put.body).toEqual({ updated: 1, removed: 0 });
    expect((await quoteFor(nw, [{ variantId: mug }])).body.totalMinor).toBe('1025');
    await nw
      .put(`/v1/admin/pricing/books/${books[0].id}/list-prices`)
      .send({ items: [{ variantId: mug, amount: null }] })
      .expect(200);
    const missing = await quoteFor(nw, [{ variantId: mug }]);
    expect(missing.status).toBe(422);
    expect(missing.body.message).toMatch(/No list price/);
    await nw
      .put(`/v1/admin/pricing/books/${books[0].id}/list-prices`)
      .send({ items: [{ variantId: mug, amount: '9.50' }] })
      .expect(200);
  });
});

describe('storefront quotes, isolation and permissions (PR-11)', () => {
  const sf = () => request(app.getHttpServer());

  it('quotes published items for the domain and hides unpublished ones', async () => {
    const mug = await variant(northwind, 'NW-MUG-01');
    const r = await sf()
      .post('/v1/storefront/pricing-quotes')
      .set('Host', 'northwind.localhost')
      .send({ lines: [{ variantId: mug }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      currency: 'GBP',
      totalMinor: '950',
      lines: [{ components: [{ label: 'List price', amountMinor: '950' }] }],
    });
    expect(r.body.notes.join(' ')).toMatch(/held until/);
    expect(JSON.stringify(r.body)).not.toMatch(/ruleId|rateId|bookId/);
    const sku = `DRAFT-${uid()}`;
    await nw
      .post('/v1/admin/products')
      .send({ title: `Draft ${sku}`, variants: [{ sku }] })
      .expect(201);
    const hidden = await sf()
      .post('/v1/storefront/pricing-quotes')
      .set('Host', 'northwind.localhost')
      .send({ lines: [{ variantId: await variant(northwind, sku) }] });
    expect(hidden.status).toBe(404);
    // Another tenant's variant through this domain is not found either.
    const cross = await sf()
      .post('/v1/storefront/pricing-quotes')
      .set('Host', 'northwind.localhost')
      .send({ lines: [{ variantId: await variant(aurum, 'AUR-BAND22-14') }] });
    expect(cross.status).toBe(404);
  });

  it('rate limits per IP', async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keys = ['::ffff:127.0.0.1', '127.0.0.1', '::1'].map((ip) => `rl:sf-quote:${ip}`);
    try {
      for (const k of keys) await redis.set(k, '1000', 'EX', 60);
      const r = await sf()
        .post('/v1/storefront/pricing-quotes')
        .set('Host', 'northwind.localhost')
        .send({ lines: [{ variantId: await variant(northwind, 'NW-MUG-01') }] });
      expect(r.status).toBe(429);
    } finally {
      await redis.del(...keys);
      redis.disconnect();
    }
  });

  it('other tenants see nothing; viewers read only', async () => {
    const rate = (await au.get('/v1/admin/rates?limit=1')).body.items[0];
    expect((await lu.get(`/v1/admin/rates/${rate.id}`)).status).toBe(404);
    const quote = (await au.get('/v1/admin/pricing/quotes?limit=1')).body.items[0];
    expect((await lu.get(`/v1/admin/pricing/quotes/${quote.id}`)).status).toBe(404);
    expect((await lu.post(`/v1/admin/pricing/quotes/${quote.id}/revalidate`).send({})).status).toBe(404);
    expect((await quoteFor(lu, [{ variantId: await variant(aurum, 'AUR-BAND22-14') }])).status).toBe(404);
    const auBooks = (await au.get('/v1/admin/pricing/books')).body.items;
    expect((await lu.get(`/v1/admin/pricing/books/${auBooks[0].id}/rules`)).status).toBe(404);
    expect((await lu.post(`/v1/admin/rates/${rate.id}/approve`).send({})).status).toBe(404);

    expect((await av.get('/v1/admin/rates/current')).status).toBe(200);
    expect((await av.get('/v1/admin/pricing/books')).status).toBe(200);
    expect(
      (
        await av
          .post('/v1/admin/rates')
          .send({ purityId: p22, value: '1', unit: 'per_g', reason: 'Viewer try' })
      ).body.code,
    ).toBe('PERMISSION_DENIED');
    expect((await av.post('/v1/admin/pricing/books').send({ name: 'Nope' })).body.code).toBe(
      'PERMISSION_DENIED',
    );
    expect((await av.put('/v1/admin/pricing/settings').send({ version: 0 })).body.code).toBe(
      'PERMISSION_DENIED',
    );
  });
});
