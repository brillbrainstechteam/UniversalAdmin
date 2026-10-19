import {
  CONNECTORS,
  ConnectionSettings,
  DEFAULT_OWNERSHIP,
  Ownership,
  type Connection,
  type MappingRule,
} from '@uc/contracts';
import { SIMULATOR_MAPPING, initialSimulatorState, type SimulatorState } from '@uc/connector-sdk';
import { connections, type Tx } from '@uc/db';
import { and, eq } from 'drizzle-orm';
import { AppError, Errors } from '../../common/errors';
import { iso } from '../../common/mappers';
import type { TenantState } from '../../common/request';

export type ConnectionRow = typeof connections.$inferSelect;

export function requireIntegrations(ctx: TenantState): void {
  if (!ctx.features.includes('integrations')) throw Errors.featureNotEntitled('integrations');
}

/** Imports and reconciliation touch every location, so location-scoped members cannot run them. */
export function requireUnscoped(ctx: TenantState): void {
  if (ctx.locationScope !== null) {
    throw new AppError(
      403,
      'LOCATION_OUT_OF_SCOPE',
      'Only members without a location scope can run ERP imports',
    );
  }
}

/** Column names of the downloadable generic CSV template; the default file mapping uses them. */
export const FILE_TEMPLATE_COLUMNS = [
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
] as const;

export const FILE_TEMPLATE_MAPPING: MappingRule[] = [
  { target: 'externalId', source: 'external_id', transform: 'trim' },
  { target: 'recordType', source: 'record_type', transform: 'lower' },
  { target: 'sku', source: 'sku', transform: 'upper' },
  { target: 'title', source: 'title', transform: 'trim' },
  { target: 'productType', source: 'product_type', transform: 'lower' },
  { target: 'purity', source: 'purity', transform: 'upper' },
  { target: 'grossWeight', source: 'gross_wt_g', transform: 'trim', weightUnit: 'g' },
  { target: 'netWeight', source: 'net_wt_g', transform: 'trim', weightUnit: 'g' },
  { target: 'stoneWeight', source: 'stone_wt_g', transform: 'trim', weightUnit: 'g' },
  { target: 'huid', source: 'huid', transform: 'upper' },
  { target: 'tag', source: 'tag_no', transform: 'upper' },
  { target: 'location', source: 'location', transform: 'lower' },
  { target: 'quantity', source: 'quantity', transform: 'trim' },
  { target: 'unit', source: 'unit', transform: 'lower' },
  { target: 'version', source: 'version', transform: 'trim' },
  { target: 'updatedAt', source: 'updated_at', transform: 'trim' },
  { target: 'deleted', source: 'deleted', transform: 'lower' },
];

export function defaultMapping(connectorKey: string): MappingRule[] {
  return connectorKey === 'simulator' ? SIMULATOR_MAPPING : FILE_TEMPLATE_MAPPING;
}

export const parseSettings = (v: unknown): ConnectionSettings => ConnectionSettings.parse(v ?? {});
export const parseOwnership = (v: unknown): Ownership =>
  Ownership.parse({ ...DEFAULT_OWNERSHIP, ...(v as object) });
export const simulatorState = (row: ConnectionRow): SimulatorState => ({
  ...initialSimulatorState(),
  ...(row.adapterState as Partial<SimulatorState>),
});

function ago(from: Date, now: Date): string {
  const min = Math.round((now.getTime() - from.getTime()) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

export function toConnection(
  row: ConnectionRow,
  stats: { openIssues: number; pendingOutbound: number; failedOutbound: number },
): Connection {
  const def = CONNECTORS[row.connectorKey];
  const now = new Date();
  const freshness = row.lastSuccessAt
    ? `Data as of the sync ${ago(row.lastSuccessAt, now)} (${def?.tier === 'file' ? 'manual file upload' : 'pulled on demand'}; not real-time)`
    : 'Never synced';
  return {
    id: row.id,
    connectorKey: row.connectorKey,
    connectorLabel: def?.label ?? row.connectorKey,
    name: row.name,
    status: row.status,
    credentialRef: row.credentialRef,
    settings: parseSettings(row.settings),
    ownership: parseOwnership(row.ownership),
    activeMappingVersion: row.activeMappingVersion,
    lastSyncAt: row.lastSyncAt ? iso(row.lastSyncAt) : null,
    lastSuccessAt: row.lastSuccessAt ? iso(row.lastSuccessAt) : null,
    freshness,
    openIssues: stats.openIssues,
    pendingOutbound: stats.pendingOutbound,
    failedOutbound: stats.failedOutbound,
    version: row.version,
    createdAt: iso(row.createdAt),
  };
}

export async function loadConnection(
  tx: Tx,
  ctx: TenantState,
  id: string,
  lock = false,
): Promise<ConnectionRow> {
  const q = tx
    .select()
    .from(connections)
    .where(and(eq(connections.tenantId, ctx.tenantId), eq(connections.id, id)));
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw Errors.notFound('Connection');
  return row;
}
