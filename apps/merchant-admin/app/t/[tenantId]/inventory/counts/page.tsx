'use client';

import type { Page, StockCount } from '@uc/contracts';
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

type Row = Omit<StockCount, 'lines'> & { lineCount: number };

export default function CountsPage() {
  const { can, tenantId, context } = useTenant();
  const enabled = can('inventory.read') && context.features.includes('inventory');
  const tz = context.tenant.timezone;
  const [locationId, setLocationId] = useState('');
  const pager = useCursorPagination(locationId);
  const list = useTenantQuery<Page<Row>>(
    ['inventory', 'counts'],
    '/v1/admin/inventory/counts',
    { locationId, cursor: pager.cursor, limit: 25 },
    enabled,
  );
  const locations = useLocations(enabled);
  if (!enabled) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="Stocktakes"
        description="Counted quantities replace the system figure through variance movements. A count taken earlier than the last applied count for the same location is recorded as stale and not applied."
        actions={
          can('inventory.adjust') && (
            <Link href={`/t/${tenantId}/inventory/counts/new`} className="uc-btn" data-variant="primary">
              New stocktake
            </Link>
          )
        }
      />
      <InventoryTabs />
      <Card>
        <div className="uc-filters" role="search">
          <SelectField
            label="Location"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            options={[{ value: '', label: 'All my locations' }, ...locations.options]}
          />
        </div>
        <DataTable
          caption="Stocktakes"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(c) => c.id!}
          pagination={pager.controls(list.data?.nextCursor)}
          empty={
            <EmptyState title="No stocktakes yet" description="Count a location to correct its stock." />
          }
          columns={[
            {
              key: 'asof',
              header: 'Counted at',
              render: (c) => (
                <Link href={`/t/${tenantId}/inventory/counts/${c.id}`}>{formatDateTime(c.asOf, tz)}</Link>
              ),
            },
            { key: 'loc', header: 'Location', render: (c) => c.location.name },
            { key: 'src', header: 'Source', render: (c) => c.source },
            { key: 'lines', header: 'Lines', render: (c) => c.lineCount },
            { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
            { key: 'ref', header: 'Reference', render: (c) => c.reference ?? '—' },
            { key: 'by', header: 'By', render: (c) => c.createdBy?.name ?? '—' },
          ]}
        />
      </Card>
    </>
  );
}
