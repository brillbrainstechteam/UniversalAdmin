'use client';

import type { Page, StockMovement } from '@uc/contracts';
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  ForbiddenState,
  PageHeader,
  SelectField,
  TextField,
  formatDateTime,
  useCursorPagination,
} from '@uc/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { InventoryTabs, MOVEMENT_LABELS, qtyText, useLocations } from '../../../../../lib/inventory';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

function Ledger() {
  const { can, tenantId, context } = useTenant();
  const enabled = can('inventory.read') && context.features.includes('inventory');
  const tz = context.tenant.timezone;
  const params = useSearchParams();
  const variantId = params.get('variantId') ?? '';
  const operationId = params.get('operationId') ?? '';
  const [type, setType] = useState('');
  const [locationId, setLocationId] = useState('');
  const [reference, setReference] = useState(params.get('reference') ?? '');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(reference.trim()), 300);
    return () => clearTimeout(t);
  }, [reference]);
  const filters = { variantId, operationId, type, locationId, reference: debounced };
  const pager = useCursorPagination(JSON.stringify(filters));
  const list = useTenantQuery<Page<StockMovement>>(
    ['inventory', 'movements'],
    '/v1/admin/inventory/movements',
    { ...filters, cursor: pager.cursor, limit: 50 },
    enabled,
  );
  const locations = useLocations(enabled);
  if (!enabled) return <ForbiddenState />;
  const delta = (v: string) =>
    /^-?0(\.0+)?$/.test(v) ? (
      <span className="uc-muted">·</span>
    ) : v.startsWith('-') ? (
      `−${qtyText(v.slice(1))}`
    ) : (
      `+${qtyText(v)}`
    );
  return (
    <>
      <PageHeader
        title="Stock ledger"
        description="Append-only record of every stock change. Rows can never be edited or deleted; corrections are new movements."
      />
      <InventoryTabs />
      {(variantId || operationId) && (
        <Card>
          <span className="uc-row">
            Filtered to one {variantId ? 'variant' : 'operation'}.{' '}
            <Link href={`/t/${tenantId}/inventory/movements`}>Show all</Link>
          </span>
        </Card>
      )}
      <Card>
        <div className="uc-filters" role="search">
          <SelectField
            label="Type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            options={[
              { value: '', label: 'Any' },
              ...Object.entries(MOVEMENT_LABELS).map(([value, label]) => ({ value, label })),
            ]}
          />
          <SelectField
            label="Location"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            options={[{ value: '', label: 'All my locations' }, ...locations.options]}
          />
          <TextField
            label="Reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Exact document number"
          />
        </div>
        <DataTable
          caption="Stock movements"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(m) => m.id}
          pagination={pager.controls(list.data?.nextCursor)}
          empty={<EmptyState title="No movements" description="Nothing matches these filters." />}
          columns={[
            { key: 'at', header: 'When', render: (m) => formatDateTime(m.occurredAt, tz) },
            { key: 'type', header: 'Type', render: (m) => MOVEMENT_LABELS[m.type] ?? m.type },
            {
              key: 'sku',
              header: 'SKU',
              render: (m) => (
                <Link href={`/t/${tenantId}/inventory/variants/${m.variantId}`} className="uc-mono">
                  {m.sku}
                </Link>
              ),
            },
            {
              key: 'loc',
              header: 'Location',
              render: (m) => `${m.location.name} · ${m.condition.replace('_', ' ')}`,
            },
            { key: 'oh', header: 'On hand Δ', render: (m) => delta(m.onHandDelta) },
            { key: 'res', header: 'Held Δ', render: (m) => delta(m.reservedDelta) },
            { key: 'com', header: 'Committed Δ', render: (m) => delta(m.committedDelta) },
            {
              key: 'ref',
              header: 'Reference / note',
              render: (m) => (
                <>
                  {m.serialItem && <span className="uc-mono">{m.serialItem.serialTag} </span>}
                  {m.reference && <span className="uc-mono">{m.reference} </span>}
                  {m.reasonCode && <Badge>{m.reasonCode.replace(/_/g, ' ')}</Badge>} {m.note}
                </>
              ),
            },
            { key: 'by', header: 'By', render: (m) => m.actor?.name ?? 'System' },
          ]}
        />
      </Card>
    </>
  );
}

export default function MovementsPage() {
  return (
    <Suspense>
      <Ledger />
    </Suspense>
  );
}
