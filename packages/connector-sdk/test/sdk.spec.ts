import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  FileFormatError,
  SIMULATOR_MAPPING,
  applyMapping,
  initialSimulatorState,
  parseTabular,
  parseTimestamp,
  simulatorAdapter,
  simulatorPushOrder,
  simulatorSnapshot,
  stableJson,
  validateRules,
} from '../src';
import type { MappingRule } from '@uc/contracts';

const rules: MappingRule[] = [
  { target: 'externalId', source: 'id', transform: 'trim' },
  { target: 'sku', source: 'Design Code', transform: 'upper' },
  { target: 'title', source: 'name', transform: 'trim' },
  { target: 'grossWeight', source: 'gross', transform: 'trim', weightUnit: 'mg' },
  { target: 'netWeight', source: 'net', transform: 'trim', weightUnit: 'kg' },
  { target: 'stoneWeight', source: 'stone', transform: 'trim', weightUnit: 'ct' },
  { target: 'tag', source: 'tag', transform: 'upper' },
  { target: 'purity', source: 'karat', transform: 'upper' },
  { target: 'quantity', source: 'qty', transform: 'trim' },
  { target: 'unit', source: 'uom', transform: 'lower' },
  { target: 'updatedAt', source: 'modified', transform: 'trim' },
  { target: 'deleted', source: 'status', transform: 'lower' },
];

describe('mapping engine', () => {
  it('converts weights exactly from mg/kg/ct and infers pieces from a tag', () => {
    const r = applyMapping(rules, {
      id: ' P-1 ',
      'design code': 'ring-01', // header match is case-insensitive
      name: 'Ring',
      gross: '12345',
      net: '0.012',
      stone: '1.5',
      tag: 't-9',
      karat: '22k',
      qty: '',
      uom: 'Nos',
      modified: '2026-03-01 10:15',
      status: 'Active',
    });
    expect(r.errors).toEqual([]);
    expect(r.record).toMatchObject({
      externalId: 'P-1',
      recordType: 'piece',
      productType: 'jewellery',
      sku: 'RING-01',
      grossG: '12.345000',
      netG: '12.000000',
      stoneG: '0.300000',
      tag: 'T-9',
      purity: '22K',
      unit: 'pcs',
      updatedAt: '2026-03-01T10:15:00.000Z',
      deleted: false,
    });
  });

  it('reports every problem per field instead of dropping the row', () => {
    const r = applyMapping(rules, {
      id: '',
      'Design Code': '',
      gross: '12,5',
      qty: '1.5',
      uom: 'boxes',
      modified: '31/12/2026',
      status: 'maybe',
    });
    expect(r.record).toBeNull();
    expect(r.errors.map((e) => e.field)).toEqual([
      'externalId',
      'sku',
      'unit',
      'quantity',
      'grossWeight',
      'updatedAt',
      'deleted',
    ]);
  });

  it('accepts grams for designs, rejects carats for metal weight, flags sold rows as deleted', () => {
    const base = { id: 'D1', 'Design Code': 'CH-1', qty: '12.5', uom: 'gms', status: 'sold' };
    expect(applyMapping(rules, base).record).toMatchObject({
      recordType: 'design',
      unit: 'g',
      quantity: '12.5',
      deleted: true,
    });
    const ct: MappingRule[] = [
      ...rules.filter((x) => x.target !== 'grossWeight'),
      { target: 'grossWeight', source: 'gross', transform: 'trim', weightUnit: 'ct' },
    ];
    expect(applyMapping(ct, { ...base, gross: '5' }).errors[0]).toMatchObject({
      field: 'grossWeight',
      message: expect.stringContaining('stone'),
    });
    expect(applyMapping(rules, { ...base, uom: 'pcs', qty: '1.5' }).errors[0]!.field).toBe('quantity');
  });

  it('validates rule sets and parses timestamps', () => {
    expect(validateRules([{ target: 'title', source: 'x', transform: 'trim' }]).map((p) => p.field)).toEqual([
      'externalId',
      'sku',
    ]);
    expect(validateRules([...rules, { target: 'sku', source: 'y', transform: 'trim' }])[0]!.message).toMatch(
      /twice/,
    );
    expect(parseTimestamp('2026-02-30')).toBeNull();
    expect(parseTimestamp('2026-01-31T23:59:59+05:30')).toBe('2026-01-31T18:29:59.000Z');
    expect(stableJson({ b: 1, a: [2, { d: 3, c: null }] })).toBe('{"a":[2,{"c":null,"d":3}],"b":1}');
  });
});

describe('file parsing', () => {
  it('reads CSV with BOM, quotes and CRLF, and rejects broken files clearly', async () => {
    const t = await parseTabular('a.csv', Buffer.from('﻿id,name\r\n1,"Ring, ""gold"""\r\n\r\n2,Chain\r\n'));
    expect(t.columns).toEqual(['id', 'name']);
    expect(t.rows).toEqual([
      { rowNo: 2, values: { id: '1', name: 'Ring, "gold"' } },
      { rowNo: 4, values: { id: '2', name: 'Chain' } },
    ]);
    await expect(parseTabular('a.csv', Buffer.from('id,id\n1,2'))).rejects.toThrow(FileFormatError);
    await expect(parseTabular('a.csv', Buffer.from('id,name\n1,"open'))).rejects.toThrow(/Unterminated/);
    await expect(parseTabular('a.csv', Buffer.from([0x89, 0x50, 0x00, 0x47]))).rejects.toThrow(/neither CSV/);
    await expect(parseTabular('x.xlsx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).rejects.toThrow(
      /xlsx/,
    );
  });

  it('reads the first worksheet of an XLSX without float artefacts', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Stock');
    ws.addRow(['id', 'gross', 'qty', 'when']);
    ws.addRow(['A1', 0.1 + 0.2, 3, new Date(Date.UTC(2026, 0, 31, 10, 0, 0))]);
    ws.addRow([]);
    ws.addRow(['A2', 12.3456789, 0, 'text']);
    const t = await parseTabular('stock.xlsx', Buffer.from(await wb.xlsx.writeBuffer()));
    expect(t.columns).toEqual(['id', 'gross', 'qty', 'when']);
    expect(t.rows.map((r) => r.values)).toEqual([
      { id: 'A1', gross: '0.3', qty: '3', when: '2026-01-31T10:00:00.000Z' },
      { id: 'A2', gross: '12.345679', qty: '0', when: 'text' },
    ]);
  });
});

describe('simulator', () => {
  it('is deterministic and maps cleanly with its own mapping', () => {
    expect(simulatorSnapshot(3, { pieces: true })).toEqual(simulatorSnapshot(3, { pieces: true }));
    for (const tick of [0, 1, 2, 3, 4, 5, 9]) {
      for (const raw of simulatorSnapshot(tick, { pieces: true })) {
        expect(applyMapping(SIMULATOR_MAPPING, raw).errors, `${tick}:${raw.ITEM_ID}`).toEqual([]);
      }
    }
    expect(simulatorSnapshot(0, { pieces: false })).toHaveLength(5);
    expect(simulatorSnapshot(0, { pieces: true })).toHaveLength(9);
    expect(simulatorSnapshot(2, { pieces: false }).map((r) => r.DESIGN_CODE)).toContain('SIM-NEW-02');
  });

  it('dedupes orders by reference and injects outages and timeouts', async () => {
    let s = { ...initialSimulatorState(), failNext: 1, timeoutNext: 1 };
    let r = simulatorPushOrder(s, 'R1');
    expect(r.error).toMatchObject({ maybeAccepted: false });
    s = r.state;
    r = simulatorPushOrder(s, 'R1');
    expect(r.error).toMatchObject({ maybeAccepted: true }); // accepted, then timed out
    s = r.state;
    r = simulatorPushOrder(s, 'R1');
    expect(r.externalRef).toBe('SIM-SO-00001');
    expect(Object.keys(r.state.orders)).toEqual(['R1']);
    const pulled = await simulatorAdapter.pullItems!(
      { ...initialSimulatorState(), tick: 2, pieces: false },
      null,
    );
    expect(pulled).toMatchObject({ cursor: '2', asOf: '2026-01-01T11:00:00.000Z' });
  });
});
