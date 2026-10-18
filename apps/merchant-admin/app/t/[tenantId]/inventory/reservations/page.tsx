'use client';

import type { Page, Reservation } from '@uc/contracts';
import {
  Alert,
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
import { InventoryTabs, qtyText, useInventoryAction, useLocations } from '../../../../../lib/inventory';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

export default function ReservationsPage() {
  const { can, tenantId, context, api } = useTenant();
  const enabled = can('inventory.read') && context.features.includes('inventory');
  const tz = context.tenant.timezone;
  const [status, setStatus] = useState('held');
  const [locationId, setLocationId] = useState('');
  const pager = useCursorPagination(status + locationId);
  const list = useTenantQuery<Page<Reservation>>(
    ['inventory', 'reservations'],
    '/v1/admin/inventory/reservations',
    { status, locationId, cursor: pager.cursor, limit: 25 },
    enabled,
  );
  const locations = useLocations(enabled);
  const [release, setRelease] = useState<Reservation | null>(null);
  const commit = useInventoryAction(
    (id: string) => api<Reservation>(`/v1/admin/inventory/reservations/${id}/commit`, { method: 'POST' }),
    'Hold committed',
  );
  const doRelease = useInventoryAction(
    (reason: string) =>
      api<Reservation>(`/v1/admin/inventory/reservations/${release!.id}/release`, {
        method: 'POST',
        body: { reason: reason || undefined },
      }),
    'Reservation released',
    () => setRelease(null),
  );
  if (!enabled) return <ForbiddenState />;
  const canReserve = can('inventory.reserve');
  return (
    <>
      <PageHeader
        title="Reservations"
        description="Holds keep stock aside for a limited time and expire automatically; committed stock is promised (e.g. to an order) until it is released or fulfilled."
      />
      <InventoryTabs />
      <Card>
        <div className="uc-filters" role="search">
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: 'held', label: 'Held' },
              { value: 'committed', label: 'Committed' },
              { value: 'released', label: 'Released' },
              { value: 'expired', label: 'Expired' },
              { value: '', label: 'All' },
            ]}
          />
          <SelectField
            label="Location"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            options={[{ value: '', label: 'All my locations' }, ...locations.options]}
          />
        </div>
        {commit.error && <Alert tone="danger">{errorMessage(commit.error)}</Alert>}
        <DataTable
          caption="Reservations"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(r) => r.id}
          pagination={pager.controls(list.data?.nextCursor)}
          empty={<EmptyState title="No reservations" description="Hold stock from a variant’s stock page." />}
          columns={[
            {
              key: 'sku',
              header: 'SKU / product',
              render: (r) => (
                <>
                  <Link href={`/t/${tenantId}/inventory/variants/${r.variantId}`} className="uc-mono">
                    {r.sku}
                  </Link>
                  <br />
                  <span className="uc-muted">{r.productTitle}</span>
                </>
              ),
            },
            {
              key: 'qty',
              header: 'Quantity / piece',
              render: (r) =>
                r.serialItem ? (
                  <span className="uc-mono">{r.serialItem.serialTag}</span>
                ) : (
                  qtyText(r.quantity)
                ),
            },
            { key: 'loc', header: 'Location', render: (r) => r.location.name },
            { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            {
              key: 'ref',
              header: 'Reference',
              render: (r) => `${r.referenceType}${r.referenceId ? ` · ${r.referenceId}` : ''}`,
            },
            {
              key: 'when',
              header: 'Expires / closed',
              render: (r) =>
                r.status === 'held' && r.expiresAt
                  ? formatDateTime(r.expiresAt, tz)
                  : r.closedAt
                    ? `${formatDateTime(r.closedAt, tz)}${r.closedReason ? ` (${r.closedReason})` : ''}`
                    : '—',
            },
            { key: 'by', header: 'By', render: (r) => r.createdBy?.name ?? 'System' },
            {
              key: 'act',
              header: 'Actions',
              render: (r) =>
                canReserve && (r.status === 'held' || r.status === 'committed') ? (
                  <span className="uc-row">
                    {r.status === 'held' && (
                      <Button
                        size="sm"
                        loading={commit.isPending && commit.variables === r.id}
                        onClick={() => commit.mutate(r.id)}
                      >
                        Commit
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setRelease(r)}>
                      Release
                    </Button>
                  </span>
                ) : null,
            },
          ]}
        />
      </Card>
      <ConfirmDialog
        open={release !== null}
        title="Release reservation"
        description={
          release?.status === 'committed'
            ? 'This stock was committed. Releasing returns it to available stock.'
            : 'The held stock returns to available stock immediately.'
        }
        confirmLabel="Release"
        requireReason={release?.status === 'committed'}
        loading={doRelease.isPending}
        error={doRelease.error ? errorMessage(doRelease.error) : null}
        onConfirm={(reason) => doRelease.mutate(reason)}
        onClose={() => setRelease(null)}
      />
    </>
  );
}
