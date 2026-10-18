import type { INestApplication } from '@nestjs/common';
import { createDb, expireReservations, requireEnv, systemTx } from '@uc/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditCount,
  createMember,
  CSRF,
  locationId,
  login,
  ownerPool,
  startApp,
  tenantId,
  type Agent,
} from '../helpers';

let app: INestApplication;
let aurum: string;
let lumiere: string;
let main: string;
let mumbai: string;
let jaipur: string;
const worker = createDb(requireEnv('TEST_DATABASE_URL'), { max: 2 });

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
let au: Client;
let lu: Client;

let seq = 0;
const uid = () => `${Date.now().toString(36)}-${++seq}-${Math.random().toString(36).slice(2, 7)}`;
const key = () => `key-${uid()}`;
const g = (value: string) => ({ value, unit: 'g' as const });

async function newVariants(c: Client, n = 1, productType: 'standard' | 'jewellery' = 'standard') {
  const res = await c.post('/v1/admin/products').send({
    title: `Stock test ${uid()}`,
    productType,
    options: n > 1 ? [{ name: 'Size', values: Array.from({ length: n }, (_, i) => `S${i}`) }] : [],
    variants: Array.from({ length: n }, (_, i) => ({
      sku: `INV-${uid()}`.toUpperCase(),
      optionValues: n > 1 ? { Size: `S${i}` } : {},
    })),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body.variants as { id: string }[]).map((v) => v.id);
}

async function receive(c: Client, variantId: string, loc: string, quantity: string, reference?: string) {
  const res = await c
    .post('/v1/admin/inventory/receipts', key())
    .send({ locationId: loc, reference, lines: [{ variantId, quantity }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function hold(c: Client, body: Record<string, unknown>, k = key()) {
  return c.post('/v1/admin/inventory/reservations', k).send({ quantity: '1', ...body });
}

async function balance(variantId: string, loc: string, condition = 'sellable') {
  const { rows } = await ownerPool.query(
    'select on_hand, reserved, committed from stock_balances where variant_id = $1 and location_id = $2 and condition = $3',
    [variantId, loc, condition],
  );
  return (
    (rows[0] as { on_hand: string; reserved: string; committed: string } | undefined) ?? {
      on_hand: '0.000000',
      reserved: '0.000000',
      committed: '0.000000',
    }
  );
}

async function level(c: Client, variantId: string, query = '') {
  const v = (await c.get(`/v1/admin/inventory/variants/${variantId}${query}`)).body;
  return v as { atp: { total: string; byChannel: { channelId: string; atp: string }[] } };
}

async function ledgerSum(variantId: string) {
  const { rows } = await ownerPool.query(
    'select coalesce(sum(on_hand_delta), 0)::text oh, coalesce(sum(reserved_delta), 0)::text r from stock_movements where variant_id = $1',
    [variantId],
  );
  return rows[0] as { oh: string; r: string };
}

beforeAll(async () => {
  app = await startApp();
  aurum = await tenantId('aurum-wholesale');
  lumiere = await tenantId('lumiere-fine');
  main = await locationId('aurum-wholesale', 'main-wh');
  mumbai = await locationId('aurum-wholesale', 'mumbai-branch');
  jaipur = await locationId('aurum-wholesale', 'jaipur-branch');
  au = scoped(await login(app, 'owner@aurum.demo'), aurum);
  lu = scoped(await login(app, 'owner@lumiere.demo'), lumiere);
});
afterAll(async () => {
  await app.close();
  await worker.close();
});

describe('receipts: no double counting (I-03)', () => {
  it('a replayed request or a re-sent reference counts once; balances equal the ledger', async () => {
    const [v] = await newVariants(au);
    const ref = `GRN-${uid()}`;
    const k = key();
    const body = { locationId: main, reference: ref, lines: [{ variantId: v, quantity: '5' }] };
    const first = await au.post('/v1/admin/inventory/receipts', k).send(body);
    expect(first.status).toBe(201);
    expect(first.body.movements).toHaveLength(1);
    expect(first.body.movements[0]).toMatchObject({
      type: 'receipt',
      onHandDelta: '5.000000',
      reference: ref,
    });
    const replay = await au.post('/v1/admin/inventory/receipts', k).send(body);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.operationId).toBe(first.body.operationId);
    const resent = await au.post('/v1/admin/inventory/receipts', key()).send(body);
    expect(resent.status).toBe(409);
    expect(resent.body).toMatchObject({ code: 'DUPLICATE', details: { field: 'reference' } });
    expect((await balance(v!, main)).on_hand).toBe('5.000000');
    expect((await ledgerSum(v!)).oh).toBe('5.000000');
    const noKey = await au.post('/v1/admin/inventory/receipts').send({ ...body, reference: undefined });
    expect(noKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(await auditCount(aurum, 'inventory.received')).toBeGreaterThan(0);
    const events = await ownerPool.query(
      "select count(*)::int n from outbox_events where event_type = 'InventoryMovementRecorded' and aggregate_id = $1",
      [first.body.operationId],
    );
    expect(events.rows[0].n).toBe(1);
  });

  it('validates quantities exactly (whole pieces, gram decimals) and rejects unknown variants', async () => {
    const [v] = await newVariants(au);
    const frac = await au
      .post('/v1/admin/inventory/receipts', key())
      .send({ locationId: main, lines: [{ variantId: v, quantity: '1.5' }] });
    expect(frac.status).toBe(400);
    expect(frac.body.details[0]).toMatchObject({
      path: 'lines.0.quantity',
      message: expect.stringContaining('whole'),
    });
    const s = await au.put(`/v1/admin/inventory/variants/${v}/settings`).send({ version: 0, unit: 'g' });
    expect(s.status).toBe(200);
    await receive(au, v!, main, '12.345678');
    expect((await balance(v!, main)).on_hand).toBe('12.345678');
    const tooPrecise = await au
      .post('/v1/admin/inventory/receipts', key())
      .send({ locationId: main, lines: [{ variantId: v, quantity: '0.1234567' }] });
    expect(tooPrecise.status).toBe(400);
    const relocked = await au
      .put(`/v1/admin/inventory/variants/${v}/settings`)
      .send({ version: 1, unit: 'pcs' });
    expect(relocked.body.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('adjustments and condition changes (I-04, I-08)', () => {
  it('need a reason and permission, can never go negative or below holds, and are audited', async () => {
    const [v] = await newVariants(au);
    await receive(au, v!, main, '5');
    const adj = (delta: string, extra: Record<string, unknown> = {}) =>
      au.post('/v1/admin/inventory/adjustments', key()).send({
        locationId: main,
        reasonCode: 'loss',
        note: 'Shelf audit difference',
        lines: [{ variantId: v, delta }],
        ...extra,
      });
    expect((await adj('-1', { note: '' })).status).toBe(400);
    const viewer = scoped(await login(app, 'viewer@aurum.demo'), aurum);
    const denied = await viewer.post('/v1/admin/inventory/adjustments', key()).send({
      locationId: main,
      reasonCode: 'loss',
      note: 'Not allowed',
      lines: [{ variantId: v, delta: '-1' }],
    });
    expect(denied.body.code).toBe('PERMISSION_DENIED');
    const negative = await adj('-6');
    expect(negative.status).toBe(409);
    expect(negative.body.code).toBe('INSUFFICIENT_STOCK');
    expect((await balance(v!, main)).on_hand).toBe('5.000000');
    expect((await hold(au, { variantId: v, quantity: '2', locationId: main })).status).toBe(201);
    expect((await adj('-4')).body.code).toBe('INSUFFICIENT_STOCK'); // 1 left < 2 held
    const before = await auditCount(aurum, 'inventory.adjusted');
    expect((await adj('-3')).status).toBe(201);
    expect(await auditCount(aurum, 'inventory.adjusted')).toBe(before + 1);
    expect(await balance(v!, main)).toMatchObject({ on_hand: '2.000000', reserved: '2.000000' });
    const { rows } = await ownerPool.query(
      "select reason_code, note from stock_movements where variant_id = $1 and type = 'adjustment'",
      [v],
    );
    expect(rows).toEqual([{ reason_code: 'loss', note: 'Shelf audit difference' }]);
  });

  it('damaged and quarantined stock is not sellable; ATP honours the buffer', async () => {
    const [v] = await newVariants(au);
    await receive(au, v!, main, '6');
    const cc = await au.post('/v1/admin/inventory/condition-changes').send({
      locationId: main,
      variantId: v,
      from: 'sellable',
      to: 'damaged',
      quantity: '1',
      note: 'Clasp broken in display',
    });
    expect(cc.status).toBe(201);
    expect(cc.body.movements).toHaveLength(2);
    expect((await level(au, v!)).atp.total).toBe('5.000000');
    const s = await au.put(`/v1/admin/inventory/variants/${v}/settings`).send({ version: 0, buffer: '2' });
    expect(s.body).toMatchObject({ buffer: '2.000000', effectiveBuffer: '2.000000' });
    expect((await level(au, v!)).atp.total).toBe('3.000000');
    const sku = (await au.get(`/v1/admin/inventory/variants/${v}`)).body.sku as string;
    const row = (await au.get('/v1/admin/inventory/levels').query({ q: sku })).body.items[0];
    expect(row).toMatchObject({
      onHand: '5.000000',
      unsellable: '1.000000',
      atp: '3.000000',
      lowStock: false,
    });
    const tooMuch = await hold(au, { variantId: v, quantity: '4' });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.details).toMatchObject({ atp: '3.000000', buffer: '2.000000' });
    expect((await hold(au, { variantId: v, quantity: '3' })).status).toBe(201);
    const out = (await au.get('/v1/admin/inventory/levels').query({ q: sku, stock: 'out' })).body.items;
    expect(out.map((r: { variantId: string }) => r.variantId)).toEqual([v]);
    // Cannot move more damaged stock than exists.
    const moveBack = await au.post('/v1/admin/inventory/condition-changes').send({
      locationId: main,
      variantId: v,
      from: 'damaged',
      to: 'quarantine',
      quantity: '2',
      note: 'More than is damaged',
    });
    expect(moveBack.body.code).toBe('INSUFFICIENT_STOCK');
  });

  it('channel stock locations limit channel ATP and channel holds', async () => {
    const [v] = await newVariants(au);
    await receive(au, v!, main, '4');
    await receive(au, v!, mumbai, '1');
    const channels = (await au.get('/v1/admin/inventory/channels')).body.items as { channelId: string }[];
    const ch = channels[0]!.channelId;
    const put = await au.put(`/v1/admin/inventory/channels/${ch}/locations`).send({ locationIds: [mumbai] });
    expect(put.status).toBe(200);
    try {
      expect((await level(au, v!)).atp.byChannel.find((c) => c.channelId === ch)?.atp).toBe('1.000000');
      const sku = (await au.get(`/v1/admin/inventory/variants/${v}`)).body.sku as string;
      const viaChannel = (await au.get('/v1/admin/inventory/levels').query({ q: sku, channelId: ch })).body
        .items[0];
      expect(viaChannel.atp).toBe('1.000000');
      expect((await hold(au, { variantId: v, quantity: '2', channelId: ch })).body.code).toBe(
        'INSUFFICIENT_STOCK',
      );
      const ok = await hold(au, { variantId: v, quantity: '1', channelId: ch });
      expect(ok.status).toBe(201);
      expect(ok.body.location.id).toBe(mumbai);
    } finally {
      await au.put(`/v1/admin/inventory/channels/${ch}/locations`).send({ locationIds: [] });
    }
  });
});

describe('reservations: concurrency, idempotency, lifecycle (I-01, I-02)', () => {
  it('many concurrent holds for the last unit: exactly one wins and nothing is oversold', async () => {
    const [v] = await newVariants(au);
    await receive(au, v!, main, '1');
    const results = await Promise.all(
      Array.from({ length: 12 }, () => hold(au, { variantId: v, quantity: '1' })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(11);
    for (const r of results.filter((x) => x.status === 409)) expect(r.body.code).toBe('INSUFFICIENT_STOCK');
    expect(await balance(v!, main)).toMatchObject({ on_hand: '1.000000', reserved: '1.000000' });
    expect((await ledgerSum(v!)).r).toBe('1.000000');
  });

  it('parallel retries with the same Idempotency-Key create one hold and replay it', async () => {
    const [v] = await newVariants(au);
    await receive(au, v!, main, '3');
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => hold(au, { variantId: v, quantity: '1' }, k)),
    );
    expect(results.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect((await balance(v!, main)).reserved).toBe('1.000000');
    const reused = await hold(au, { variantId: v, quantity: '2' }, k);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('held → committed → released; invalid transitions are rejected; events and audit are written', async () => {
    const [v] = await newVariants(au);
    await receive(au, v!, main, '3');
    const h = (
      await hold(au, { variantId: v, quantity: '2', referenceType: 'quote', referenceId: 'Q-DEMO-1' })
    ).body;
    expect(h).toMatchObject({ status: 'held', quantity: '2.000000', referenceType: 'quote' });
    const c = await au.post(`/v1/admin/inventory/reservations/${h.id}/commit`);
    expect(c.body.status).toBe('committed');
    expect(await balance(v!, main)).toMatchObject({ reserved: '0.000000', committed: '2.000000' });
    expect((await au.post(`/v1/admin/inventory/reservations/${h.id}/commit`)).body.code).toBe(
      'INVALID_STATE_TRANSITION',
    );
    const noReason = await au.post(`/v1/admin/inventory/reservations/${h.id}/release`).send({});
    expect(noReason.status).toBe(400);
    const r = await au
      .post(`/v1/admin/inventory/reservations/${h.id}/release`)
      .send({ reason: 'Order cancelled by buyer' });
    expect(r.body).toMatchObject({ status: 'released', closedReason: 'Order cancelled by buyer' });
    expect(await balance(v!, main)).toMatchObject({
      on_hand: '3.000000',
      reserved: '0.000000',
      committed: '0.000000',
    });
    expect(
      (await au.post(`/v1/admin/inventory/reservations/${h.id}/release`).send({ reason: 'again' })).body.code,
    ).toBe('INVALID_STATE_TRANSITION');
    const ev = await ownerPool.query(
      'select event_type from outbox_events where aggregate_id = $1 order by occurred_at',
      [h.id],
    );
    expect(ev.rows.map((x) => x.event_type)).toEqual([
      'ReservationCreated',
      'ReservationCommitted',
      'ReservationReleased',
    ]);
    expect(await auditCount(aurum, 'reservation.committed')).toBeGreaterThan(0);
  });

  it('expired holds free stock inline on the next reserve and via the worker, exactly once', async () => {
    const [v] = await newVariants(au);
    await receive(au, v!, main, '1');
    const a = (await hold(au, { variantId: v, ttlMinutes: 1 })).body;
    expect((await hold(au, { variantId: v })).body.code).toBe('INSUFFICIENT_STOCK');
    await ownerPool.query("update reservations set expires_at = now() - interval '1 second' where id = $1", [
      a.id,
    ]);
    // Commit after expiry is refused even before anything has swept it.
    expect((await au.post(`/v1/admin/inventory/reservations/${a.id}/commit`)).body.code).toBe(
      'RESERVATION_EXPIRED',
    );
    const b = await hold(au, { variantId: v });
    expect(b.status).toBe(201); // inline expiry released the old hold first
    const old = await ownerPool.query('select status, closed_reason from reservations where id = $1', [a.id]);
    expect(old.rows[0]).toEqual({ status: 'expired', closed_reason: 'ttl' });
    expect((await balance(v!, main)).reserved).toBe('1.000000');

    // Worker path: expire b, then a second pass finds nothing (idempotent).
    await ownerPool.query("update reservations set expires_at = now() - interval '1 second' where id = $1", [
      b.body.id,
    ]);
    const first = await systemTx(worker.db, (tx) => expireReservations(tx, { tenantId: aurum }));
    const second = await systemTx(worker.db, (tx) => expireReservations(tx, { tenantId: aurum }));
    expect(first).toBeGreaterThanOrEqual(1);
    expect(second).toBe(0);
    expect((await balance(v!, main)).reserved).toBe('0.000000');
    const ev = await ownerPool.query(
      "select count(*)::int n from outbox_events where event_type = 'ReservationExpired' and aggregate_id = any($1)",
      [[a.id, b.body.id]],
    );
    expect(ev.rows[0].n).toBe(2);
  });
});

describe('transfers and location scope (I-05)', () => {
  it('moves stock through in transit; scoped operators act only at their locations', async () => {
    const [v] = await newVariants(au);
    await receive(au, v!, main, '5');
    const stock = scoped(await login(app, 'stock@aurum.demo'), aurum); // Mumbai only
    const fromMain = await stock
      .post('/v1/admin/inventory/transfers', key())
      .send({ fromLocationId: main, toLocationId: mumbai, lines: [{ variantId: v, quantity: '1' }] });
    expect(fromMain.body.code).toBe('LOCATION_OUT_OF_SCOPE');
    const t = await au
      .post('/v1/admin/inventory/transfers', key())
      .send({ fromLocationId: main, toLocationId: mumbai, lines: [{ variantId: v, quantity: '3' }] });
    expect(t.status).toBe(201);
    expect(t.body).toMatchObject({ status: 'in_transit', number: expect.stringMatching(/^TR-\d{6}$/) });
    expect((await balance(v!, main)).on_hand).toBe('2.000000');
    expect((await balance(v!, mumbai, 'in_transit')).on_hand).toBe('3.000000');
    expect((await level(au, v!)).atp.total).toBe('2.000000'); // in transit is not sellable

    // The scoped operator sees only Mumbai, and receives the transfer there.
    const seen = (await stock.get(`/v1/admin/inventory/variants/${v}`)).body;
    expect(seen.balances.every((b: { location: { id: string } }) => b.location.id === mumbai)).toBe(true);
    const adjMain = await stock.post('/v1/admin/inventory/adjustments', key()).send({
      locationId: main,
      reasonCode: 'found',
      note: 'Outside my scope',
      lines: [{ variantId: v, delta: '1' }],
    });
    expect(adjMain.body.code).toBe('LOCATION_OUT_OF_SCOPE');
    const received = await stock
      .post(`/v1/admin/inventory/transfers/${t.body.id}/receive`)
      .send({ version: 0 });
    expect(received.status).toBe(200);
    expect(received.body).toMatchObject({ status: 'received', receivedBy: { name: expect.any(String) } });
    expect((await balance(v!, mumbai, 'in_transit')).on_hand).toBe('0.000000');
    expect((await balance(v!, mumbai)).on_hand).toBe('3.000000');
    const again = await stock.post(`/v1/admin/inventory/transfers/${t.body.id}/receive`).send({ version: 1 });
    expect(again.body.code).toBe('INVALID_STATE_TRANSITION');

    const t2 = await au
      .post('/v1/admin/inventory/transfers', key())
      .send({ fromLocationId: main, toLocationId: jaipur, lines: [{ variantId: v, quantity: '2' }] });
    expect((await stock.get(`/v1/admin/inventory/transfers/${t2.body.id}`)).status).toBe(404);
    const cancelled = await au
      .post(`/v1/admin/inventory/transfers/${t2.body.id}/cancel`)
      .send({ version: 0, note: 'Wrong branch' });
    expect(cancelled.body.status).toBe('cancelled');
    expect((await balance(v!, main)).on_hand).toBe('2.000000');
    expect((await balance(v!, jaipur, 'in_transit')).on_hand).toBe('0.000000');
    const tooMuch = await au
      .post('/v1/admin/inventory/transfers', key())
      .send({ fromLocationId: main, toLocationId: jaipur, lines: [{ variantId: v, quantity: '3' }] });
    expect(tooMuch.body.code).toBe('INSUFFICIENT_STOCK');
  });
});

describe('stocktakes (I-06)', () => {
  it('previews without writing, posts variance, and records an older snapshot as stale', async () => {
    const [v, w] = await newVariants(au, 2);
    await receive(au, v!, jaipur, '10');
    const t2 = new Date(Date.now() - 60_000).toISOString();
    const t1 = new Date(Date.now() - 3_600_000).toISOString();
    const body = (asOf: string, counted: string, dryRun = false) => ({
      locationId: jaipur,
      asOf,
      dryRun,
      lines: [
        { variantId: v, counted },
        { variantId: w, counted: '2' },
      ],
    });
    const preview = await au.post('/v1/admin/inventory/counts').send(body(t2, '8', true));
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ status: 'preview', id: null });
    expect(preview.body.lines[0]).toMatchObject({ expected: '10.000000', variance: '-2.000000' });
    expect((await balance(v!, jaipur)).on_hand).toBe('10.000000');

    const applied = await au.post('/v1/admin/inventory/counts').send(body(t2, '8'));
    expect(applied.status).toBe(201);
    expect(applied.body.status).toBe('applied');
    expect((await balance(v!, jaipur)).on_hand).toBe('8.000000');
    expect((await balance(w!, jaipur)).on_hand).toBe('2.000000');
    const moves = (await au.get('/v1/admin/inventory/movements').query({ operationId: applied.body.id })).body
      .items;
    expect(moves.map((m: { onHandDelta: string }) => m.onHandDelta).sort()).toEqual([
      '-2.000000',
      '2.000000',
    ]);

    const stale = await au.post('/v1/admin/inventory/counts').send(body(t1, '50'));
    expect(stale.status).toBe(201);
    expect(stale.body.status).toBe('rejected_stale');
    expect(stale.body.issueId).toEqual(expect.any(String));
    expect((await balance(v!, jaipur)).on_hand).toBe('8.000000');
    const issues = (await au.get('/v1/admin/inventory/issues').query({ kind: 'stale_snapshot' })).body.items;
    expect(issues.some((i: { id: string }) => i.id === stale.body.issueId)).toBe(true);
    const snap = await ownerPool.query(
      "select payload->>'status' s from outbox_events where event_type = 'InventorySnapshotReceived' and aggregate_id = $1",
      [stale.body.id],
    );
    expect(snap.rows[0].s).toBe('rejected_stale');

    await hold(au, { variantId: v, quantity: '3', locationId: jaipur });
    const below = await au.post('/v1/admin/inventory/counts').send(body(new Date().toISOString(), '2'));
    expect(below.body.code).toBe('INSUFFICIENT_STOCK');
    const future = await au
      .post('/v1/admin/inventory/counts')
      .send(body(new Date(Date.now() + 3_600_000).toISOString(), '8'));
    expect(future.status).toBe(400);
  });
});

describe('serialized pieces (I-07)', () => {
  it('each piece is in one place; holds reserve that exact piece; written-off pieces leave stock', async () => {
    const [v] = await newVariants(au, 1, 'jewellery');
    const purities = (await au.get('/v1/admin/jewellery/purities')).body.items as {
      id: string;
      code: string;
    }[];
    const purityId = purities.find((p) => p.code === '22K')!.id;
    const piece = async () =>
      (
        await au
          .post('/v1/admin/serial-items')
          .send({ variantId: v, purityId, serialTag: `PC-${uid()}`, gross: g('5.1'), net: g('5.0') })
      ).body as { id: string; version: number; stockState: string };
    const [p1, p2] = [await piece(), await piece()];
    expect(p1.stockState).toBe('not_received');
    const pending = (
      await au.post('/v1/admin/serial-items').send({
        variantId: v,
        purityId,
        serialTag: `PC-${uid()}`,
        gross: g('5'),
        net: g('5.2'),
        weightExceptionReason: 'Gross scale under repair',
      })
    ).body;
    const notActive = await au
      .post('/v1/admin/inventory/receipts', key())
      .send({ locationId: main, lines: [{ variantId: v, serialItemIds: [pending.id] }] });
    expect(notActive.status).toBe(400);

    const rec = await au
      .post('/v1/admin/inventory/receipts', key())
      .send({ locationId: main, lines: [{ variantId: v, serialItemIds: [p1.id, p2.id] }] });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    expect((await au.get(`/v1/admin/inventory/variants/${v}`)).body.settings.tracking).toBe('serial');
    expect((await balance(v!, main)).on_hand).toBe('2.000000');
    const again = await au
      .post('/v1/admin/inventory/receipts', key())
      .send({ locationId: main, lines: [{ variantId: v, serialItemIds: [p1.id] }] });
    expect(again.body.code).toBe('INVALID_STATE_TRANSITION');
    const qtyLine = await au
      .post('/v1/admin/inventory/receipts', key())
      .send({ locationId: main, lines: [{ variantId: v, quantity: '1' }] });
    expect(qtyLine.status).toBe(400);
    expect((await hold(au, { variantId: v })).status).toBe(400); // must name the piece

    const racers = await Promise.all(
      Array.from({ length: 8 }, () => hold(au, { variantId: v, serialItemId: p1.id })),
    );
    expect(racers.filter((r) => r.status === 201)).toHaveLength(1);
    const won = racers.find((r) => r.status === 201)!.body;
    expect(won.serialItem).toMatchObject({ id: p1.id });
    const item = (await au.get(`/v1/admin/serial-items/${p1.id}`)).body;
    expect(item).toMatchObject({ stockState: 'reserved', location: { id: main } });

    expect(
      (
        await au
          .post(`/v1/admin/inventory/serial-items/${p1.id}/write-off`)
          .send({ reason: 'Lost in transit' })
      ).body.code,
    ).toBe('INVALID_STATE_TRANSITION');
    const retireHeld = await au
      .patch(`/v1/admin/serial-items/${p1.id}`)
      .send({ version: item.version, status: 'retired' });
    expect(retireHeld.body.code).toBe('INVALID_STATE_TRANSITION');
    await au.post(`/v1/admin/inventory/reservations/${won.id}/release`).send({});
    expect((await au.get(`/v1/admin/serial-items/${p1.id}`)).body.stockState).toBe('in_stock');

    const wo = await au
      .post(`/v1/admin/inventory/serial-items/${p1.id}/write-off`)
      .send({ reason: 'Melted for remake' });
    expect(wo.status).toBe(201);
    const after = (await au.get(`/v1/admin/serial-items/${p1.id}`)).body;
    expect(after).toMatchObject({ stockState: 'written_off', location: null });
    expect((await balance(v!, main)).on_hand).toBe('1.000000');
    expect(
      (await au.patch(`/v1/admin/serial-items/${p1.id}`).send({ version: after.version, status: 'retired' }))
        .status,
    ).toBe(200);
    const transfer = await au
      .post('/v1/admin/inventory/transfers', key())
      .send({ fromLocationId: main, toLocationId: mumbai, lines: [{ variantId: v, serialItemId: p2.id }] });
    expect(transfer.status).toBe(201);
    expect((await au.get(`/v1/admin/serial-items/${p2.id}`)).body).toMatchObject({
      stockState: 'in_transit',
      location: { id: mumbai },
    });
    await au.post(`/v1/admin/inventory/transfers/${transfer.body.id}/receive`).send({ version: 0 });
    expect((await au.get(`/v1/admin/serial-items/${p2.id}`)).body.stockState).toBe('in_stock');
    const listed = (await au.get('/v1/admin/serial-items').query({ variantId: v, stockState: 'in_stock' }))
      .body.items;
    expect(listed.map((i: { id: string }) => i.id)).toEqual([p2.id]);
  });
});

describe('ledger integrity, reconciliation and isolation (I-03, I-09)', () => {
  it('the ledger is append-only for the app role and the table owner', async () => {
    const { rows } = await ownerPool.query('select id from stock_movements limit 1');
    await expect(
      ownerPool.query("update stock_movements set note = 'x' where id = $1", [rows[0].id]),
    ).rejects.toThrow();
    await expect(
      ownerPool.query('delete from stock_movements where id = $1', [rows[0].id]),
    ).rejects.toThrow();
    await expect(
      worker.pool.query("update stock_movements set note = 'x' where id = $1", [rows[0].id]),
    ).rejects.toThrow(/permission denied/);
  });

  it('reconciliation detects a tampered balance once, and a person resolves it', async () => {
    const [v] = await newVariants(lu);
    const lMain = await locationId('lumiere-fine', 'main-wh');
    await receive(lu, v!, lMain, '4');
    expect((await lu.post('/v1/admin/inventory/reconcile')).body).toMatchObject({ mismatches: 0 });
    await ownerPool.query('update stock_balances set on_hand = on_hand + 1 where variant_id = $1', [v]);
    try {
      const first = (await lu.post('/v1/admin/inventory/reconcile')).body;
      expect(first).toMatchObject({ mismatches: 1, issuesOpened: 1 });
      const second = (await lu.post('/v1/admin/inventory/reconcile')).body;
      expect(second).toMatchObject({ mismatches: 1, issuesOpened: 0 });
      const issue = (await lu.get('/v1/admin/inventory/issues')).body.items.find(
        (i: { variant: { id: string } | null }) => i.variant?.id === v,
      );
      expect(issue).toMatchObject({
        kind: 'ledger_balance_mismatch',
        severity: 'critical',
        details: { check: 'ledger', balance_on_hand: '5.000000', ledger_on_hand: '4.000000' },
      });
      expect(
        (await lu.post(`/v1/admin/inventory/issues/${issue.id}/resolve`).send({ note: 'x' })).status,
      ).toBe(400);
      const resolved = await lu
        .post(`/v1/admin/inventory/issues/${issue.id}/resolve`)
        .send({ note: 'Restored from ledger by DBA' });
      expect(resolved.body).toMatchObject({
        status: 'resolved',
        resolutionNote: 'Restored from ledger by DBA',
      });
      // Aurum never sees Lumière's issues.
      const aurumIssues = (await au.get('/v1/admin/inventory/issues').query({ status: 'resolved' })).body
        .items;
      expect(aurumIssues.some((i: { id: string }) => i.id === issue.id)).toBe(false);
    } finally {
      await ownerPool.query('update stock_balances set on_hand = on_hand - 1 where variant_id = $1', [v]);
    }
    expect((await lu.post('/v1/admin/inventory/reconcile')).body.mismatches).toBe(0);
  });

  it('another tenant cannot read or act on inventory data', async () => {
    const [v] = await newVariants(au);
    await receive(au, v!, main, '2');
    const h = (await hold(au, { variantId: v })).body;
    expect((await lu.get(`/v1/admin/inventory/variants/${v}`)).status).toBe(404);
    expect((await lu.post(`/v1/admin/inventory/reservations/${h.id}/commit`)).status).toBe(404);
    expect((await lu.post(`/v1/admin/inventory/reservations/${h.id}/release`).send({})).status).toBe(404);
    const steal = await lu
      .post('/v1/admin/inventory/receipts', key())
      .send({ locationId: main, lines: [{ variantId: v, quantity: '1' }] });
    expect(steal.status).toBe(400);
    const moves = (await lu.get('/v1/admin/inventory/movements').query({ variantId: v })).body.items;
    expect(moves).toEqual([]);
    const levels = (await lu.get('/v1/admin/inventory/levels').query({ limit: 100 })).body.items;
    expect(levels.some((l: { variantId: string }) => l.variantId === v)).toBe(false);
  });

  it('roles and navigation: sales reps can hold but not adjust; nav includes Inventory', async () => {
    const rep = await createMember(aurum, ['sales_rep']);
    const c = scoped(await login(app, rep.email), aurum);
    const [v] = await newVariants(au);
    await receive(au, v!, main, '2');
    expect((await hold(c, { variantId: v })).status).toBe(201);
    const adj = await c.post('/v1/admin/inventory/adjustments', key()).send({
      locationId: main,
      reasonCode: 'found',
      note: 'Not my job',
      lines: [{ variantId: v, delta: '1' }],
    });
    expect(adj.body.code).toBe('PERMISSION_DENIED');
    const ctx = (await au.get('/v1/admin/context')).body;
    expect(ctx.nav.map((n: { key: string }) => n.key)).toContain('inventory');
    const summary = (await au.get('/v1/admin/inventory/summary')).body;
    expect(summary.trackedVariants).toBeGreaterThan(0);
    expect(summary.activeHolds).toBeGreaterThan(0);
  });
});
