'use client';

import type { Page, ReconcileResponse, ReconciliationIssue } from '@uc/contracts';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ForbiddenState,
  PageHeader,
  SelectField,
  StatusBadge,
  errorMessage,
  formatDateTime,
  useCursorPagination,
} from '@uc/ui';
import Link from 'next/link';
import { useState } from 'react';
import { InventoryTabs, useInventoryAction } from '../../../../../lib/inventory';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

const KINDS: Record<string, string> = {
  ledger_balance_mismatch: 'Balance ≠ ledger / reservations',
  serial_state_mismatch: 'Pieces ≠ balance',
  stale_snapshot: 'Stale count',
  stocktake_variance: 'Stocktake variance',
};

function describe(i: ReconciliationIssue): string {
  const d = i.details as Record<string, string>;
  if (i.kind === 'stale_snapshot')
    return `Count as of ${d.asOf} is older than the applied count as of ${d.newerAsOf}`;
  if (d.check === 'ledger')
    return `${d.condition}: balance on hand ${d.balance_on_hand} vs ledger ${d.ledger_on_hand}; held ${d.balance_reserved} vs ${d.ledger_reserved}; committed ${d.balance_committed} vs ${d.ledger_committed}`;
  if (d.check === 'reservations')
    return `held ${d.balance_reserved} vs open holds ${d.held_reservations}; committed ${d.balance_committed} vs commitments ${d.committed_reservations}`;
  if (d.check === 'pieces')
    return `${d.condition}: balance ${d.balance_on_hand} vs pieces ${d.pieces_on_hand} (held ${d.balance_reserved}/${d.pieces_reserved}, committed ${d.balance_committed}/${d.pieces_committed})`;
  return JSON.stringify(i.details);
}

export default function IssuesPage() {
  const { can, tenantId, context, api } = useTenant();
  const enabled = can('inventory.read') && context.features.includes('inventory');
  const tz = context.tenant.timezone;
  const [status, setStatus] = useState('open');
  const [kind, setKind] = useState('');
  const pager = useCursorPagination(status + kind);
  const list = useTenantQuery<Page<ReconciliationIssue>>(
    ['inventory', 'issues'],
    '/v1/admin/inventory/issues',
    { status, kind, cursor: pager.cursor, limit: 25 },
    enabled,
  );
  const [resolving, setResolving] = useState<ReconciliationIssue | null>(null);
  const reconcile = useInventoryAction(
    () => api<ReconcileResponse>('/v1/admin/inventory/reconcile', { method: 'POST' }),
    (r) => `Checked ${r.checked} balances: ${r.mismatches} mismatch(es), ${r.issuesOpened} new issue(s)`,
  );
  const resolve = useInventoryAction(
    (note: string) =>
      api<ReconciliationIssue>(`/v1/admin/inventory/issues/${resolving!.id}/resolve`, {
        method: 'POST',
        body: { note },
      }),
    'Issue resolved',
    () => setResolving(null),
  );
  if (!enabled) return <ForbiddenState />;
  const canAdjust = can('inventory.adjust');
  return (
    <>
      <PageHeader
        title="Reconciliation issues"
        description="Balances are checked against the ledger, open reservations and serialized pieces every few minutes. Nothing is auto-corrected: investigate, fix with an adjustment or stocktake, then resolve with a note."
        actions={
          canAdjust && (
            <Button loading={reconcile.isPending} onClick={() => reconcile.mutate(undefined)}>
              Run check now
            </Button>
          )
        }
      />
      <InventoryTabs />
      <Card>
        <div className="uc-filters" role="search">
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'resolved', label: 'Resolved' },
            ]}
          />
          <SelectField
            label="Kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            options={[
              { value: '', label: 'Any' },
              ...Object.entries(KINDS).map(([value, label]) => ({ value, label })),
            ]}
          />
        </div>
        <DataTable
          caption="Reconciliation issues"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(i) => i.id}
          pagination={pager.controls(list.data?.nextCursor)}
          empty={
            <EmptyState
              title={status === 'open' ? 'No open issues' : 'No resolved issues'}
              description="Stock figures agree with the ledger."
            />
          }
          columns={[
            { key: 'at', header: 'Found', render: (i) => formatDateTime(i.createdAt, tz) },
            {
              key: 'kind',
              header: 'Kind',
              render: (i) => (
                <span className="uc-row">
                  <Badge
                    tone={
                      i.severity === 'critical' ? 'danger' : i.severity === 'warning' ? 'warning' : 'info'
                    }
                  >
                    {i.severity}
                  </Badge>
                  {KINDS[i.kind] ?? i.kind}
                </span>
              ),
            },
            {
              key: 'what',
              header: 'Where',
              render: (i) => (
                <>
                  {i.variant && (
                    <Link href={`/t/${tenantId}/inventory/variants/${i.variant.id}`} className="uc-mono">
                      {i.variant.sku}
                    </Link>
                  )}{' '}
                  {i.location?.name}
                </>
              ),
            },
            {
              key: 'details',
              header: 'Details',
              render: (i) => <span className="uc-muted">{describe(i)}</span>,
            },
            {
              key: 'status',
              header: 'Status',
              render: (i) =>
                i.status === 'open' ? (
                  canAdjust ? (
                    <Button size="sm" onClick={() => setResolving(i)}>
                      Resolve
                    </Button>
                  ) : (
                    <StatusBadge status="open" />
                  )
                ) : (
                  <span>
                    Resolved by {i.resolvedBy?.name ?? '—'}: {i.resolutionNote}
                  </span>
                ),
            },
          ]}
        />
      </Card>
      <ConfirmDialog
        open={resolving !== null}
        title="Resolve issue"
        description="Describe what was found and how it was fixed (e.g. the adjustment or stocktake you posted). If the mismatch persists, the next check reports it again."
        confirmLabel="Resolve"
        tone="primary"
        requireReason
        loading={resolve.isPending}
        error={resolve.error ? errorMessage(resolve.error) : null}
        onConfirm={(note) => resolve.mutate(note)}
        onClose={() => setResolving(null)}
      />
    </>
  );
}
