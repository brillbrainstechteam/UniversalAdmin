/**
 * Connector SDK (Phase 05, ADR-019). Adapters translate a source system into canonical records; everything after
 * that (dedupe, ownership, stock snapshots, outbox, retries) is shared platform code, so a new vendor adapter only
 * implements the operations its vendor really supports.
 */
import type { ConnectorCapabilities } from '@uc/contracts';

export * from './mapping';
export * from './files';
export * from './simulator';
export * from './adapters';

export interface SourceRow {
  rowNo: number;
  values: Record<string, unknown>;
}

export interface PullResult {
  rows: SourceRow[];
  /** Opaque checkpoint after this pull (monotonic per stream). */
  cursor: string;
  /** Source time the snapshot represents. */
  asOf: string;
}

/** Operation contract (specs/05). Unsupported operations are declared in `capabilities` and never called. */
export interface ConnectorAdapter<State = unknown> {
  key: string;
  capabilities: ConnectorCapabilities;
  testConnection(state: State): Promise<{ ok: boolean; message: string }>;
  pullItems?(state: State, cursor: string | null): Promise<PullResult>;
  pushOrder?(
    state: State,
    command: { reference: string; payload: Record<string, unknown> },
  ): Promise<{ state: State; externalRef?: string; error?: Error & { maybeAccepted?: boolean } }>;
  health(state: State): Promise<{ status: 'ok' | 'degraded' | 'down'; detail: string }>;
}
