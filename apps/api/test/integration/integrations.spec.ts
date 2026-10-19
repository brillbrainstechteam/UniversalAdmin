import type { INestApplication } from '@nestjs/common';
import { ADAPTERS } from '@uc/connector-sdk';
import { createDb, relayOutboundCommands, requireEnv, type OrderPushAdapter } from '@uc/db';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditCount, CSRF, locationId, login, ownerPool, startApp, tenantId, type Agent } from '../helpers';

let app: INestApplication;
let aurum: string;
let lumiere: string;
let main: string;
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
const uid = () => `${Date.now().toString(36)}${++seq}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

const HEADER =
  'external_id,record_type,sku,title,product_type,purity,gross_wt_g,net_wt_g,stone_wt_g,huid,tag_no,location,quantity,unit,version,updated_at,deleted';
type Line = Partial<Record<(typeof COLS)[number], string>>;
const COLS = HEADER.split(',') as readonly string[] as readonly [
  'external_id',
  'record_type',
  'sku',
  'title',
  'product_type',
  'purity',
  'gross_wt_g',
  'net_wt_g',
  'stone_wt_g',
  'huid',
  'tag_no',
  'location',
  'quantity',
  'unit',
  'version',
  'updated_at',
  'deleted',
];
const csv = (lines: Line[]) =>
  [HEADER, ...lines.map((l) => COLS.map((c) => (l[c] ?? '').replace(/,/g, ' ')).join(','))].join('\n');
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

async function connection(c: Client, connectorKey: string, extra: Record<string, unknown> = {}) {
  const res = await c
    .post('/v1/admin/integrations/connections')
    .send({ connectorKey, name: `Test ${connectorKey} ${uid()}`, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; version: number };
}
async function upload(c: Client, connId: string, content: string | Buffer, fileName = 'stock.csv') {
  const res = await c
    .post(`/v1/admin/integrations/connections/${connId}/jobs/file`)
    .send({ fileName, contentBase64: b64(content) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; counts: Record<string, number>; status: string; stockResult: unknown };
}
async function commit(c: Client, jobId: string, mode: 'atomic' | 'partial' = 'atomic') {
  return c.post(`/v1/admin/integrations/jobs/${jobId}/commit`).send({ mode });
}
async function onHand(sku: string, loc = main) {
  const { rows } = await ownerPool.query(
    `select b.on_hand from stock_balances b join variants v on v.id = b.variant_id
     where lower(v.sku) = lower($1) and b.location_id = $2 and b.condition = 'sellable'`,
    [sku, loc],
  );
  return (rows[0]?.on_hand as string | undefined) ?? null;
}
async function variantId(sku: string) {
  const { rows } = await ownerPool.query(
    'select id from variants where tenant_id = $1 and lower(sku) = lower($2)',
    [aurum, sku],
  );
  return rows[0]?.id as string | undefined;
}
const relay = () =>
  relayOutboundCommands(worker.db, ADAPTERS as Record<string, OrderPushAdapter>, { backoffBaseMs: 0 });

beforeAll(async () => {
  app = await startApp();
  aurum = await tenantId('aurum-wholesale');
  lumiere = await tenantId('lumiere-fine');
  main = await locationId('aurum-wholesale', 'main-wh');
  au = scoped(await login(app, 'owner@aurum.demo'), aurum);
  lu = scoped(await login(app, 'owner@lumiere.demo'), lumiere);
});
afterAll(async () => {
  await app.close();
  await worker.close();
});

describe('connector catalog and honest tiers (X-10)', () => {
  it('lists vendor connectors as blocked with their dependencies and refuses to connect them', async () => {
    const cat = (await au.get('/v1/admin/integrations/connectors')).body;
    const byKey = Object.fromEntries(cat.items.map((c: { key: string }) => [c.key, c]));
    expect(byKey.file_csv.status).toBe('available');
    expect(byKey.simulator.status).toBe('available');
    for (const k of ['tallyprime', 'jwelly', 'acme_infinity', 'jewels_prime']) {
      expect(byKey[k]).toMatchObject({ status: 'blocked', fallback: 'file_csv' });
      expect(byKey[k].blockedOn.length).toBeGreaterThan(0);
    }
    expect(cat.blockedDependencies.some((d: { item: string }) => /Metal-rate|metal-rate/i.test(d.item))).toBe(
      true,
    );
    const refused = await au
      .post('/v1/admin/integrations/connections')
      .send({ connectorKey: 'tallyprime', name: 'My Tally' });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'CONNECTOR_UNAVAILABLE', details: { fallback: 'file_csv' } });
  });

  it('records the vendor discovery checklist with optimistic locking', async () => {
    const put = await au.put('/v1/admin/integrations/connectors/jwelly/discovery').send({
      version: 0,
      status: 'requested',
      answers: { contact: 'sales@jwelly.com (demo)', integrationMethod: 'Unknown — asked for API docs' },
      notes: 'Email sent',
    });
    expect(put.status).toBe(200);
    const jw = put.body.items.find((c: { key: string }) => c.key === 'jwelly');
    expect(jw.discovery).toMatchObject({ status: 'requested', version: 1, notes: 'Email sent' });
    const stale = await au
      .put('/v1/admin/integrations/connectors/jwelly/discovery')
      .send({ version: 0, status: 'docs_received' });
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect(
      (
        await au
          .put('/v1/admin/integrations/connectors/file_csv/discovery')
          .send({ version: 0, status: 'requested' })
      ).status,
    ).toBe(404);
  });

  it('stores only secret references, never secret values', async () => {
    const bad = await au
      .post('/v1/admin/integrations/connections')
      .send({ connectorKey: 'file_csv', name: `Secret ${uid()}`, credentialRef: 'sk_live_supersecret' });
    expect(bad.status).toBe(400);
    const good = await connection(au, 'file_csv', { credentialRef: 'vault:erp/aurum-test' });
    const got = (await au.get(`/v1/admin/integrations/connections/${good.id}`)).body;
    expect(got.credentialRef).toBe('vault:erp/aurum-test');
    expect(got.activeMappingVersion).toBe(1);
  });
});

describe('file import: preview, commit, re-import (X-01, X-02, X-06)', () => {
  it('preview writes nothing; commit creates products and ERP stock once; CSV and XLSX both work', async () => {
    const conn = await connection(au, 'file_csv');
    const p = `IMP${uid()}`;
    const lines: Line[] = [
      {
        external_id: `${p}-1`,
        sku: `${p}-A`,
        title: 'Import ring A',
        location: 'main-wh',
        quantity: '5',
        version: '1',
      },
      {
        external_id: `${p}-2`,
        sku: `${p}-B`,
        title: 'Import ring B',
        location: 'main-wh',
        quantity: '0',
        version: '1',
      },
      {
        external_id: `${p}-3`,
        sku: `${p}-C`,
        title: 'Chain by weight',
        location: 'main-wh',
        quantity: '12.345',
        unit: 'gms',
        version: '1',
      },
    ];
    const job = await upload(au, conn.id, csv(lines));
    expect(job).toMatchObject({ status: 'previewed', counts: { total: 3, create: 3, error: 0 } });
    expect(await variantId(`${p}-A`)).toBeUndefined();
    const done = await commit(au, job.id);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({
      status: 'committed',
      counts: { applied: 3 },
      stockResult: { locations: 1 },
    });
    expect(await onHand(`${p}-A`)).toBe('5.000000');
    expect(await onHand(`${p}-C`)).toBe('12.345000');
    const moves = await ownerPool.query(
      "select count(*)::int n from stock_movements m join variants v on v.id = m.variant_id where v.sku like $1 and m.reason_code = 'erp_snapshot'",
      [`${p}-%`],
    );
    expect(moves.rows[0].n).toBe(2); // B had 0 → no movement
    expect((await commit(au, job.id)).body.code).toBe('INVALID_STATE_TRANSITION');
    expect(await auditCount(aurum, 'integration.import_committed')).toBeGreaterThan(0);

    // Same data as an Excel workbook (numbers stored as numbers) → unchanged.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Stock');
    ws.addRow(COLS as unknown as string[]);
    for (const l of lines) ws.addRow(COLS.map((c) => (c === 'quantity' ? Number(l[c]) : (l[c] ?? ''))));
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    const again = await upload(au, conn.id, xlsx, 'stock.xlsx');
    expect(again.counts).toMatchObject({ total: 3, unchanged: 3, create: 0, error: 0 });
  });

  it('re-importing 1000 records creates no duplicates; changes update only ERP-owned fields', async () => {
    const conn = await connection(au, 'file_csv');
    const p = `BULK${uid()}`;
    const lines: Line[] = Array.from({ length: 1000 }, (_, i) => ({
      external_id: `${p}-${i}`,
      sku: `${p}-${i}`,
      title: `Bulk item ${i}`,
      location: 'main-wh',
      quantity: String(i % 7),
      version: '1',
    }));
    const first = await upload(au, conn.id, csv(lines));
    expect(first.counts).toMatchObject({ create: 1000, error: 0 });
    expect((await commit(au, first.id)).body.status).toBe('committed');
    const count = async () =>
      (
        await ownerPool.query('select count(*)::int n from variants where tenant_id = $1 and sku like $2', [
          aurum,
          `${p}-%`,
        ])
      ).rows[0].n;
    expect(await count()).toBe(1000);

    const second = await upload(au, conn.id, csv(lines));
    expect(second.counts).toMatchObject({ unchanged: 1000, create: 0, update: 0 });
    expect((await commit(au, second.id)).body.status).toBe('committed');
    expect(await count()).toBe(1000);

    lines[0] = { ...lines[0], title: 'Renamed in ERP', version: '2' };
    lines[1] = { ...lines[1], quantity: '9', version: '2' };
    const third = await upload(au, conn.id, csv(lines));
    expect(third.counts).toMatchObject({ update: 2, unchanged: 998 });
    expect((await commit(au, third.id)).body.status).toBe('committed');
    expect(await count()).toBe(1000);
    const title = await ownerPool.query(
      'select p.title from products p join variants v on v.product_id = p.id where v.sku = $1',
      [`${p}-0`],
    );
    expect(title.rows[0].title).toBe('Bulk item 0'); // title owned by commerce (default ownership)
    expect(await onHand(`${p}-1`)).toBe('9.000000');

    // ERP owns stock: a manual adjustment is refused (X-06).
    const adj = await au.post('/v1/admin/inventory/adjustments', `adj-${uid()}`).send({
      locationId: main,
      reasonCode: 'found',
      note: 'Manual change attempt',
      lines: [{ variantId: await variantId(`${p}-1`), delta: '1' }],
    });
    expect(adj.status).toBe(409);
    expect(adj.body.code).toBe('FIELD_OWNED_BY_ERP');
  }, 180_000);
});

describe('edge cases (X-03, X-04, X-05)', () => {
  it('flags unknown locations, malformed units, bad purity and duplicates per row; atomic refuses, partial applies valid rows', async () => {
    const conn = await connection(au, 'file_csv');
    const p = `EDG${uid()}`;
    const job = await upload(
      au,
      conn.id,
      csv([
        { external_id: `${p}-1`, sku: `${p}-1`, location: 'main-wh', quantity: '2' },
        { external_id: `${p}-2`, sku: `${p}-2`, location: 'nowhere', quantity: '2' },
        { external_id: `${p}-3`, sku: `${p}-3`, location: 'main-wh', quantity: '1.5' },
        { external_id: `${p}-4`, sku: `${p}-4`, location: 'main-wh', quantity: '1', unit: 'boxes' },
        {
          external_id: `${p}-5`,
          record_type: 'piece',
          sku: `${p}-1`,
          tag_no: `${p}-T1`,
          purity: '99K',
          gross_wt_g: '5',
          net_wt_g: '4.9',
        },
        {
          external_id: `${p}-6`,
          record_type: 'piece',
          sku: `${p}-1`,
          tag_no: `${p}-T2`,
          purity: '22K',
          gross_wt_g: '5,1',
          net_wt_g: '4.9',
        },
        { external_id: `${p}-1`, sku: `${p}-1b`, location: 'main-wh', quantity: '2' },
      ]),
    );
    expect(job.counts).toMatchObject({ total: 7, create: 1, error: 6 });
    const rows = (await au.get(`/v1/admin/integrations/jobs/${job.id}/rows`).query({ action: 'error' })).body
      .items as {
      rowNo: number;
      errors: { field: string; message: string }[];
    }[];
    const fields = rows.map((r) => r.errors[0]!.field);
    expect(fields).toEqual(['location', 'quantity', 'unit', 'purity', 'grossWeight', 'externalId']);
    const errorsCsv = await au.get(`/v1/admin/integrations/jobs/${job.id}/errors.csv`);
    expect(errorsCsv.headers['content-type']).toMatch(/text\/csv/);
    expect(errorsCsv.text).toContain('Unknown location code');
    expect((await commit(au, job.id, 'atomic')).body.code).toBe('IMPORT_HAS_ERRORS');
    const partial = await commit(au, job.id, 'partial');
    expect(partial.body).toMatchObject({ status: 'partially_committed', counts: { applied: 1, error: 6 } });
    expect(await onHand(`${p}-1`)).toBe('2.000000');
  });

  it('out-of-order versions are stale; deletions are flagged, never applied; older snapshots are rejected', async () => {
    const conn = await connection(au, 'file_csv');
    const p = `ORD${uid()}`;
    const a = { external_id: `${p}-1`, sku: `${p}-1`, title: 'Ordered', location: 'main-wh' };
    await commit(
      au,
      (
        await upload(
          au,
          conn.id,
          csv([{ ...a, quantity: '4', version: '5', updated_at: '2026-03-01 10:00' }]),
        )
      ).id,
    );
    const older = await upload(
      au,
      conn.id,
      csv([{ ...a, quantity: '40', version: '3', updated_at: '2026-02-01 10:00' }]),
    );
    expect(older.counts).toMatchObject({ stale: 1 });
    await commit(au, older.id);
    expect(await onHand(`${p}-1`)).toBe('4.000000');

    // A new item whose whole snapshot is older than the applied one: product created, stock not applied.
    const late = await upload(
      au,
      conn.id,
      csv([
        {
          external_id: `${p}-2`,
          sku: `${p}-2`,
          location: 'main-wh',
          quantity: '7',
          updated_at: '2026-02-15 10:00',
        },
      ]),
    );
    const lateDone = (await commit(au, late.id)).body;
    expect(lateDone.stockResult).toMatchObject({ stale: 1 });
    expect(await onHand(`${p}-2`)).toBeNull();
    const stale = await ownerPool.query(
      "select count(*)::int n from reconciliation_issues where domain = 'integration' and kind = 'stale_snapshot' and details->>'jobId' = $1",
      [late.id],
    );
    expect(stale.rows[0].n).toBe(1);

    const del = await upload(
      au,
      conn.id,
      csv([{ ...a, quantity: '4', version: '6', updated_at: '2026-03-02 10:00', deleted: 'sold' }]),
    );
    expect(del.counts).toMatchObject({ delete: 1 });
    await commit(au, del.id);
    expect(await variantId(`${p}-1`)).toBeDefined();
    const issues = (await au.get(`/v1/admin/integrations/connections/${conn.id}/discrepancies`)).body.items;
    expect(issues.some((i: { kind: string }) => i.kind === 'erp_record_deleted')).toBe(true);
  });

  it('a SKU used by a commerce-only product collides unless linking by SKU is enabled', async () => {
    const sku = `COL${uid()}`;
    const prod = await au
      .post('/v1/admin/products')
      .send({ title: 'Commerce-made', variants: [{ sku, optionValues: {} }] });
    expect(prod.status).toBe(201);
    const conn = await connection(au, 'file_csv');
    const line = { external_id: `${sku}-x`, sku, location: 'main-wh', quantity: '3' };
    const blocked = await upload(au, conn.id, csv([line]));
    expect(blocked.counts).toMatchObject({ error: 1 });
    const updated = await au
      .patch(`/v1/admin/integrations/connections/${conn.id}`)
      .send({ version: conn.version, settings: { linkExistingBySku: true } });
    expect(updated.status).toBe(200);
    const linked = await upload(au, conn.id, csv([line]));
    expect(linked.counts).toMatchObject({ create: 1 });
    await commit(au, linked.id);
    const rec = await ownerPool.query('select internal_id from external_records where connection_id = $1', [
      conn.id,
    ]);
    expect(rec.rows[0].internal_id).toBe(prod.body.variants[0].id);
    expect(await onHand(sku)).toBe('3.000000');
  });
});

describe('simulator connector: incremental pulls, pieces, checkpoints (X-07)', () => {
  it('pulls the catalogue with pieces, then only changes, deletions and stale versions', async () => {
    const conn = await connection(au, 'simulator');
    const pull = async () => {
      const r = await au.post(`/v1/admin/integrations/connections/${conn.id}/jobs/pull`);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body as { id: string; counts: Record<string, number>; cursorTo: string };
    };
    const advance = async () =>
      (await au.post(`/v1/admin/integrations/connections/${conn.id}/simulator/advance`)).body;
    const apply = async (id: string) => {
      const r = await commit(au, id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body;
    };

    const first = await pull();
    expect(first.counts).toMatchObject({ total: 9, create: 9, error: 0 }); // 6 designs + 3 pieces
    await apply(first.id);
    expect(await onHand('SIM-RING-01')).toBe('10.000000');
    expect(await onHand('SIM-CHAIN-01')).toBe('125.500000');
    const pieces = await ownerPool.query(
      "select serial_tag, stock_state, gross_g from serial_items where tenant_id = $1 and serial_tag like 'SIM-T-%' order by serial_tag",
      [aurum],
    );
    expect(pieces.rows).toEqual([
      { serial_tag: 'SIM-T-001', stock_state: 'in_stock', gross_g: '12.345000' }, // 12345 mg → g exactly
      { serial_tag: 'SIM-T-002', stock_state: 'in_stock', gross_g: '12.410000' },
      { serial_tag: 'SIM-T-003', stock_state: 'in_stock', gross_g: '12.398000' },
    ]);
    expect(await onHand('SIM-BANG-01')).toBe('3.000000');

    expect((await pull()).counts).toMatchObject({ unchanged: 9 });

    expect((await advance()).tick).toBe(1);
    const t1 = await pull();
    expect(t1.counts).toMatchObject({ update: 1, unchanged: 8 });
    await apply(t1.id);
    expect(await onHand('SIM-RING-01')).toBe('9.000000');

    await advance();
    const t2 = await pull();
    expect(t2.counts).toMatchObject({ create: 1, update: 1 });
    await apply(t2.id);
    expect(await onHand('SIM-NEW-02')).toBe('4.000000');

    await advance();
    const t3 = await pull();
    expect(t3.counts).toMatchObject({ delete: 1, update: 1 });
    await apply(t3.id);
    expect(await onHand('SIM-EAR-01')).toBe('3.000000'); // deletion flagged, stock not touched

    await advance();
    const t4 = await pull();
    expect(t4.counts).toMatchObject({ stale: 1, update: 1 });
    await apply(t4.id);
    expect(await onHand('SIM-RING-02')).toBe('5.000000'); // the stale "99" is never applied

    const state = await advance();
    expect(state).toMatchObject({ tick: 5, description: expect.stringContaining('SIM-T-002 sold') });
    const t5 = await pull();
    expect(t5.counts).toMatchObject({ delete: 1 });
    await apply(t5.id);
    const issues = (await au.get(`/v1/admin/integrations/connections/${conn.id}/discrepancies`)).body
      .items as {
      kind: string;
      details: { externalId: string };
    }[];
    expect(
      issues
        .filter((i) => i.kind === 'erp_record_deleted')
        .map((i) => i.details.externalId)
        .sort(),
    ).toEqual(['SIM-1004', 'SIM-P-002']);
    const cp = await ownerPool.query(
      "select cursor from sync_checkpoints where connection_id = $1 and stream = 'items'",
      [conn.id],
    );
    expect(cp.rows[0].cursor).toBe('5');
    const recs = (await au.get(`/v1/admin/integrations/connections/${conn.id}/records`).query({ limit: 100 }))
      .body.items;
    expect(recs).toHaveLength(10);
  });
});

describe('reconciliation and discrepancy resolution (X-08)', () => {
  it('detects ERP vs commerce stock differences; accept-ERP posts a ledger adjustment, keep-ours only resolves', async () => {
    const conn = await connection(au, 'file_csv');
    const p = `REC${uid()}`;
    const job = await upload(
      au,
      conn.id,
      csv([
        { external_id: `${p}-1`, sku: `${p}-1`, location: 'main-wh', quantity: '5' },
        { external_id: `${p}-2`, sku: `${p}-2`, location: 'main-wh', quantity: '6' },
      ]),
    );
    await commit(au, job.id);
    expect((await au.post(`/v1/admin/integrations/connections/${conn.id}/reconcile`)).body).toMatchObject({
      compared: 2,
      mismatches: 0,
    });

    const noReason = await au
      .patch(`/v1/admin/integrations/connections/${conn.id}`)
      .send({ version: conn.version, ownership: { stock: 'commerce' } });
    expect(noReason.status).toBe(400);
    const changed = await au.patch(`/v1/admin/integrations/connections/${conn.id}`).send({
      version: conn.version,
      ownership: { stock: 'commerce' },
      reason: 'Store counts are authoritative this month',
    });
    expect(changed.body.ownership.stock).toBe('commerce');
    for (const sku of [`${p}-1`, `${p}-2`]) {
      const adj = await au.post('/v1/admin/inventory/adjustments', `adj-${uid()}`).send({
        locationId: main,
        reasonCode: 'loss',
        note: 'Shelf count difference',
        lines: [{ variantId: await variantId(sku), delta: '-2' }],
      });
      expect(adj.status, JSON.stringify(adj.body)).toBe(201);
    }
    const rec = (await au.post(`/v1/admin/integrations/connections/${conn.id}/reconcile`)).body;
    expect(rec).toMatchObject({ compared: 2, mismatches: 2, issuesOpened: 2 });
    expect((await au.post(`/v1/admin/integrations/connections/${conn.id}/reconcile`)).body.issuesOpened).toBe(
      0,
    );
    const open = (await au.get(`/v1/admin/integrations/connections/${conn.id}/discrepancies`)).body.items as {
      id: string;
      variant: { sku: string };
      details: Record<string, string>;
    }[];
    const one = open.find((i) => i.variant.sku === `${p}-1`)!;
    const two = open.find((i) => i.variant.sku === `${p}-2`)!;
    expect(one.details).toMatchObject({ erp: '5.000000', commerce: '3.000000', locationCode: 'main-wh' });

    const viewer = scoped(await login(app, 'viewer@aurum.demo'), aurum);
    const denied = await viewer
      .post(`/v1/admin/integrations/discrepancies/${one.id}/resolve`)
      .send({ decision: 'keep_commerce', note: 'Viewer attempt' });
    expect(denied.body.code).toBe('PERMISSION_DENIED');
    const accepted = await au
      .post(`/v1/admin/integrations/discrepancies/${one.id}/resolve`)
      .send({ decision: 'accept_erp', note: 'ERP figure verified' });
    expect(accepted.body).toMatchObject({ status: 'resolved' });
    expect(await onHand(`${p}-1`)).toBe('5.000000');
    const mv = await ownerPool.query(
      "select on_hand_delta from stock_movements m join variants v on v.id = m.variant_id where v.sku = $1 and m.reason_code = 'erp_reconciliation'",
      [`${p}-1`],
    );
    expect(mv.rows).toEqual([{ on_hand_delta: '2.000000' }]);
    await au
      .post(`/v1/admin/integrations/discrepancies/${two.id}/resolve`)
      .send({ decision: 'keep_commerce', note: 'Store count is right' });
    expect(await onHand(`${p}-2`)).toBe('4.000000');
    const again = await au
      .post(`/v1/admin/integrations/discrepancies/${two.id}/resolve`)
      .send({ decision: 'keep_commerce', note: 'Again please' });
    expect(again.body.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('outbound order export (X-09)', () => {
  it('retries outages with the same reference, never duplicates an ERP order, and parks exhausted commands as failed', async () => {
    const conn = await connection(au, 'simulator');
    const order = (reference: string, qty = '1') =>
      au
        .post(`/v1/admin/integrations/connections/${conn.id}/outbound/test-order`)
        .send({ reference, lines: [{ sku: 'SIM-RING-01', quantity: qty }] });
    const status = async (ref: string) =>
      (
        await ownerPool.query(
          'select status, attempts, external_ref from outbound_commands where connection_id = $1 and reference = $2',
          [conn.id, ref],
        )
      ).rows[0];
    const failures = (failNext: number, timeoutNext: number) =>
      au
        .post(`/v1/admin/integrations/connections/${conn.id}/simulator/failures`)
        .send({ failNext, timeoutNext });

    const r1 = `SO-${uid()}`;
    expect((await order(r1)).status).toBe(201);
    const replay = await order(r1);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect((await order(r1, '2')).body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    await failures(2, 0);
    await relay();
    await relay();
    expect(await status(r1)).toMatchObject({ status: 'pending', attempts: 2 });
    await relay();
    expect(await status(r1)).toMatchObject({
      status: 'acknowledged',
      attempts: 3,
      external_ref: 'SIM-SO-00001',
    });

    // Timeout after the ERP accepted: the retry returns the same ERP order number.
    const r2 = `SO-${uid()}`;
    await order(r2);
    await failures(0, 1);
    await relay();
    expect(await status(r2)).toMatchObject({ status: 'pending', attempts: 1 });
    await relay();
    expect(await status(r2)).toMatchObject({ status: 'acknowledged', external_ref: 'SIM-SO-00002' });
    expect(
      (await au.get(`/v1/admin/integrations/connections/${conn.id}/simulator`)).body.receivedOrders,
    ).toBe(2);

    const r3 = `SO-${uid()}`;
    await order(r3);
    await failures(10, 0);
    for (let i = 0; i < 5; i++) await relay();
    expect(await status(r3)).toMatchObject({ status: 'failed', attempts: 5 });
    const list = (
      await au.get('/v1/admin/integrations/outbound').query({ connectionId: conn.id, status: 'failed' })
    ).body.items;
    expect(list.map((c: { reference: string }) => c.reference)).toEqual([r3]);
    expect((await au.get(`/v1/admin/integrations/connections/${conn.id}`)).body.failedOutbound).toBe(1);
    const cmdId = list[0].id as string;
    await failures(0, 0);
    expect((await au.post(`/v1/admin/integrations/outbound/${cmdId}/retry`)).body.status).toBe('pending');
    await relay();
    expect(await status(r3)).toMatchObject({ status: 'acknowledged', external_ref: 'SIM-SO-00003' });
    const events = await ownerPool.query(
      "select event_type, count(*)::int n from outbox_events where aggregate_type = 'outbound_command' and payload->>'connectionId' = $1 group by 1 order by 1",
      [conn.id],
    );
    expect(events.rows).toEqual([
      { event_type: 'OrderExportAcknowledged', n: 3 },
      { event_type: 'OrderExportFailed', n: 1 },
      { event_type: 'OrderExportRequested', n: 3 },
    ]);

    const file = await connection(au, 'file_csv');
    const nope = await au
      .post(`/v1/admin/integrations/connections/${file.id}/outbound/test-order`)
      .send({ reference: `SO-${uid()}`, lines: [{ sku: 'X', quantity: '1' }] });
    expect(nope.body.code).toBe('CONNECTOR_UNAVAILABLE');
  });
});

describe('isolation and permissions (X-11)', () => {
  it('another tenant cannot see or act on connections, jobs, records or commands', async () => {
    const conn = await connection(au, 'file_csv');
    const job = await upload(
      au,
      conn.id,
      csv([{ external_id: `ISO${uid()}`, sku: `ISO${uid()}`, location: 'main-wh', quantity: '1' }]),
    );
    expect((await lu.get(`/v1/admin/integrations/connections/${conn.id}`)).status).toBe(404);
    expect((await lu.get(`/v1/admin/integrations/jobs/${job.id}`)).status).toBe(404);
    expect((await commit(lu, job.id)).status).toBe(404);
    expect((await lu.get(`/v1/admin/integrations/connections/${conn.id}/records`)).status).toBe(404);
    const foreignUpload = await lu
      .post(`/v1/admin/integrations/connections/${conn.id}/jobs/file`)
      .send({ fileName: 'x.csv', contentBase64: b64('a,b\n1,2') });
    expect(foreignUpload.status).toBe(404);
    const theirs = (await lu.get('/v1/admin/integrations/connections')).body.items;
    expect(theirs.some((c: { id: string }) => c.id === conn.id)).toBe(false);
  });

  it('viewers read only; location-scoped operators have no integration access; bad files are rejected clearly', async () => {
    const viewer = scoped(await login(app, 'viewer@aurum.demo'), aurum);
    expect((await viewer.get('/v1/admin/integrations/connections')).status).toBe(200);
    const create = await viewer
      .post('/v1/admin/integrations/connections')
      .send({ connectorKey: 'file_csv', name: 'Viewer' });
    expect(create.body.code).toBe('PERMISSION_DENIED');
    const stock = scoped(await login(app, 'stock@aurum.demo'), aurum);
    expect((await stock.get('/v1/admin/integrations/connectors')).body.code).toBe('PERMISSION_DENIED');
    const conn = await connection(au, 'file_csv');
    const binary = await au.post(`/v1/admin/integrations/connections/${conn.id}/jobs/file`).send({
      fileName: 'photo.csv',
      contentBase64: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x10]).toString('base64'),
    });
    expect(binary.body.code).toBe('FILE_FORMAT_INVALID');
    const headerOnly = await au
      .post(`/v1/admin/integrations/connections/${conn.id}/jobs/file`)
      .send({ fileName: 'x.csv', contentBase64: b64(HEADER) });
    expect(headerOnly.body).toMatchObject({
      code: 'FILE_FORMAT_INVALID',
      message: expect.stringContaining('no data rows'),
    });
    const ctx = (await au.get('/v1/admin/context')).body;
    expect(ctx.nav.map((n: { key: string }) => n.key)).toContain('integrations');
  });
});
