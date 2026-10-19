import { CONNECTORS } from '@uc/contracts';
import type { ConnectorAdapter } from './index';
import { simulatorPushOrder, simulatorSnapshot, type SimulatorState } from './simulator';

const BASE_TIME = Date.UTC(2026, 0, 1, 9, 0, 0);
/** Source time of the simulator snapshot at `tick` (monotonic: one simulated hour per tick). */
export const simulatorAsOf = (tick: number) =>
  new Date(BASE_TIME + Math.max(0, tick) * 3_600_000).toISOString();

export type SimulatorAdapterState = SimulatorState & { pieces: boolean };

export const simulatorAdapter: ConnectorAdapter<SimulatorAdapterState> = {
  key: 'simulator',
  capabilities: CONNECTORS.simulator!.capabilities,
  async testConnection() {
    return { ok: true, message: 'The simulator is a built-in test double and is always reachable.' };
  },
  async pullItems(state) {
    const rows = simulatorSnapshot(state.tick, { pieces: state.pieces });
    return {
      rows: rows.map((values, i) => ({ rowNo: i + 1, values })),
      cursor: String(state.tick),
      asOf: simulatorAsOf(state.tick),
    };
  },
  async pushOrder(state, command) {
    const r = simulatorPushOrder(state, command.reference);
    return { state: { ...r.state, pieces: state.pieces }, externalRef: r.externalRef, error: r.error };
  },
  async health() {
    return { status: 'ok', detail: 'Simulator (not a real ERP)' };
  },
};

/** Adapters that are built and tested. Vendor connectors are absent on purpose until certified. */
export const ADAPTERS: Record<string, ConnectorAdapter<never>> = {
  simulator: simulatorAdapter as ConnectorAdapter<never>,
};
