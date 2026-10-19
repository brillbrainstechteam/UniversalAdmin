import type { MappingRule } from '@uc/contracts';

/**
 * Deterministic ERP simulator (specs/05 "simulator" tier). It is a test double, never presented as a real ERP:
 * given the same tick it always returns the same records, and each tick introduces one documented kind of change
 * so imports, re-imports and edge cases can be demonstrated and tested reproducibly.
 */
export interface SimulatorState {
  tick: number;
  failNext: number;
  timeoutNext: number;
  /** reference → ERP order number (the simulated ERP dedupes on reference). */
  orders: Record<string, string>;
}

export const initialSimulatorState = (): SimulatorState => ({
  tick: 0,
  failNext: 0,
  timeoutNext: 0,
  orders: {},
});

export const SIMULATOR_TICKS = [
  'Initial catalogue and stock',
  'Ring 01 sold one (qty −1)',
  'New design SIM-NEW-02 added',
  'Earring SIM-EAR-01 deleted in the ERP',
  'Out-of-order: an older version of Ring 02 arrives',
  'Piece SIM-T-002 sold (marked deleted)',
];

export function describeTick(tick: number): string {
  const steps = SIMULATOR_TICKS.slice(0, Math.min(tick, SIMULATOR_TICKS.length - 1) + 1);
  return (
    steps.join(' → ') + (tick >= SIMULATOR_TICKS.length ? ` → (tick ${tick}: Ring 01 keeps selling)` : '')
  );
}

/** Field names deliberately look like a typical Indian jewellery ERP export (weights in mg, branch codes). */
export const SIMULATOR_MAPPING: MappingRule[] = [
  { target: 'externalId', source: 'ITEM_ID', transform: 'trim' },
  { target: 'recordType', source: 'REC_TYPE', transform: 'lower' },
  { target: 'sku', source: 'DESIGN_CODE', transform: 'upper' },
  { target: 'title', source: 'DESCRIPTION', transform: 'trim' },
  { target: 'productType', source: 'CATEGORY', transform: 'lower' },
  { target: 'purity', source: 'KARAT', transform: 'upper' },
  { target: 'grossWeight', source: 'GROSS_WT_MG', transform: 'trim', weightUnit: 'mg' },
  { target: 'netWeight', source: 'NET_WT_MG', transform: 'trim', weightUnit: 'mg' },
  { target: 'tag', source: 'TAG_NO', transform: 'upper' },
  { target: 'huid', source: 'HUID', transform: 'upper' },
  { target: 'location', source: 'BRANCH', transform: 'lower' },
  { target: 'quantity', source: 'QTY', transform: 'trim' },
  { target: 'unit', source: 'UOM', transform: 'lower' },
  { target: 'version', source: 'MODIFIED_SEQ', transform: 'trim' },
  { target: 'updatedAt', source: 'MODIFIED_AT', transform: 'trim' },
  { target: 'deleted', source: 'STATUS', transform: 'lower' },
];

const BASE_TIME = Date.UTC(2026, 0, 1, 9, 0, 0);
const at = (tick: number) => new Date(BASE_TIME + tick * 3_600_000).toISOString();

type Row = Record<string, string>;

function design(
  id: string,
  sku: string,
  title: string,
  qty: string,
  uom: string,
  seq: number,
  extra: Partial<Row> = {},
): Row {
  return {
    ITEM_ID: id,
    REC_TYPE: 'design',
    DESIGN_CODE: sku,
    DESCRIPTION: title,
    CATEGORY: 'standard',
    KARAT: '',
    GROSS_WT_MG: '',
    NET_WT_MG: '',
    TAG_NO: '',
    HUID: '',
    BRANCH: 'main-wh',
    QTY: qty,
    UOM: uom,
    MODIFIED_SEQ: String(seq),
    MODIFIED_AT: at(seq - 1),
    STATUS: 'active',
    ...extra,
  };
}

function piece(
  id: string,
  tag: string,
  huid: string,
  grossMg: string,
  netMg: string,
  seq: number,
  status = 'active',
): Row {
  return {
    ITEM_ID: id,
    REC_TYPE: 'piece',
    DESIGN_CODE: 'SIM-BANG-01',
    DESCRIPTION: 'Simulator 22K bangle',
    CATEGORY: 'jewellery',
    KARAT: '22K',
    GROSS_WT_MG: grossMg,
    NET_WT_MG: netMg,
    TAG_NO: tag,
    HUID: huid,
    BRANCH: 'main-wh',
    QTY: '',
    UOM: 'pcs',
    MODIFIED_SEQ: String(seq),
    MODIFIED_AT: at(seq - 1),
    STATUS: status,
  };
}

/** Full snapshot of the simulated ERP at `tick`. Pieces only for tenants with serialized jewellery. */
export function simulatorSnapshot(tick: number, options: { pieces: boolean }): Row[] {
  const t = Math.max(0, tick);
  const rows: Row[] = [
    design(
      'SIM-1001',
      'SIM-RING-01',
      'Simulator ring 01',
      String(Math.max(0, 10 - t)),
      'pcs',
      t >= 1 ? 1 + t : 1,
    ),
    t >= 4
      ? design('SIM-1002', 'SIM-RING-02', 'Simulator ring 02 (stale copy)', '99', 'pcs', 0, {
          MODIFIED_AT: at(0),
        })
      : design('SIM-1002', 'SIM-RING-02', 'Simulator ring 02', '5', 'pcs', 1),
    design('SIM-1003', 'SIM-CHAIN-01', 'Simulator chain sold by weight', '125.5', 'g', 1),
    t >= 3
      ? design('SIM-1004', 'SIM-EAR-01', 'Simulator earrings', '0', 'pcs', 4, { STATUS: 'deleted' })
      : design('SIM-1004', 'SIM-EAR-01', 'Simulator earrings', '3', 'pcs', 1),
    design('SIM-1005', 'SIM-PEN-01', 'Simulator pendant', '0', 'pcs', 1),
  ];
  if (t >= 2) rows.push(design('SIM-1007', 'SIM-NEW-02', 'Simulator new design', '4', 'pcs', 3));
  if (options.pieces) {
    rows.push(
      design('SIM-1006', 'SIM-BANG-01', 'Simulator 22K bangle', '', 'pcs', 1, { CATEGORY: 'jewellery' }),
      piece('SIM-P-001', 'SIM-T-001', 'SIM001', '12345', '12000', 1),
      piece('SIM-P-002', 'SIM-T-002', 'SIM002', '12410', '12010', t >= 5 ? 6 : 1, t >= 5 ? 'sold' : 'active'),
      piece('SIM-P-003', 'SIM-T-003', '', '12398', '12001', 1),
    );
  }
  return rows;
}

export class TransientAdapterError extends Error {
  constructor(
    message: string,
    /** True when the remote side may already have accepted the command (timeout after send). */
    readonly maybeAccepted: boolean,
  ) {
    super(message);
  }
}

/**
 * Simulated ERP order intake. Dedupe on reference makes retries after a timeout safe; failNext/timeoutNext inject
 * outages. Returns the new state (persist it) and the ERP order number, or throws TransientAdapterError.
 */
export function simulatorPushOrder(
  state: SimulatorState,
  reference: string,
): { state: SimulatorState; externalRef?: string; error?: TransientAdapterError } {
  const existing = state.orders[reference];
  if (existing) return { state, externalRef: existing };
  if (state.failNext > 0) {
    return {
      state: { ...state, failNext: state.failNext - 1 },
      error: new TransientAdapterError('Simulated ERP unavailable (HTTP 503)', false),
    };
  }
  const externalRef = `SIM-SO-${String(Object.keys(state.orders).length + 1).padStart(5, '0')}`;
  const accepted = { ...state, orders: { ...state.orders, [reference]: externalRef } };
  if (state.timeoutNext > 0) {
    return {
      state: { ...accepted, timeoutNext: state.timeoutNext - 1 },
      error: new TransientAdapterError('Simulated timeout after the ERP accepted the order', true),
    };
  }
  return { state: accepted, externalRef };
}
