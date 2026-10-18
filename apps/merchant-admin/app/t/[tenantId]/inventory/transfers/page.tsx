'use client';

import type { Page, Transfer } from '@uc/contracts';
import {
  Card,
  DataTable,
  EmptyState,
  ForbiddenState,
  PageHeader,
  SelectField,
  StatusBadge,
  formatDateTime,
  useCursorPagination,
} from '@uc/ui';
import Link from 'next/link';
import { useState } from 'react';
import { InventoryTabs, useLocations } from '../../../../../lib/inventory';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

type Row = Omit<Transfer, 'lines'> & { lineCount: number };

export default function TransfersPage() {
  const { can, tenantId, context } = useTenant();
  const enabled = can('inventory.read') && context.features.includes('inventory');
  const tz = context.tenant.timezone;
  const [status, setStatus] = useState('in_transit');
  const [locationId, setLocationId] = useState('');
  const pager = useCursorPagination(status + locationId);
  const list = useTenantQuery<Page<Row>>(
    ['inventory', 'transfers'],
    '/v1/admin/inventory/transfers',
    { status, locationId, cursor: pager.cursor, limit: 25 },
    enabled,
  );
  const locations = useLocations(enabled);
  if (!enabled) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="Transfers"
        description="Stock leaves the source when dispatched, shows as incoming (in transit) at the destination, and becomes sellable there only when received."
        actions={
          can('inventory.transfer') && (
            <Link href={`/t/${tenantId}/inventory/transfers/new`} className="uc-btn" data-variant="primary">
              New transfer
            </Link>
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
              { value: 'in_transit', label: 'In transit' },
              { value: 'received', label: 'Received' },
              { value: 'cancelled', label: 'Cancelled' },
              { value: '', label: 'All' },
            ]}
          />
          <SelectField
            label="Location"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            options={[{ value: '', label: 'Any' }, ...locations.options]}
          />
        </div>
        <DataTable
          caption="Transfers"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(t) => t.id}
          pagination={pager.controls(list.data?.nextCursor)}
          empty={
            <EmptyState
              title="No transfers"
              description="Move stock between locations with a new transfer."
            />
          }
          columns={[
            {
              key: 'num',
              header: 'Number',
              render: (t) => (
                <Link href={`/t/${tenantId}/inventory/transfers/${t.id}`} className="uc-mono">
                  {t.number}
                </Link>
              ),
            },
            { key: 'from', header: 'From', render: (t) => t.from.name },
            { key: 'to', header: 'To', render: (t) => t.to.name },
            { key: 'lines', header: 'Lines', render: (t) => t.lineCount },
            { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
            { key: 'at', header: 'Dispatched', render: (t) => formatDateTime(t.createdAt, tz) },
            { key: 'by', header: 'By', render: (t) => t.createdBy?.name ?? '—' },
          ]}
        />
      </Card>
    </>
  );
}
