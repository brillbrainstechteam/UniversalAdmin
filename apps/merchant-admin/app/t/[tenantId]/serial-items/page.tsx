'use client';

import type { Page, PurityDefinition, SerialItem } from '@uc/contracts';
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  ForbiddenState,
  PageHeader,
  SelectField,
  StatusBadge,
  TextField,
  useCursorPagination,
} from '@uc/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useTenant, useTenantQuery } from '../../../../lib/tenant';
import { grams } from '../../../../lib/weight';

type Row = Omit<SerialItem, 'components' | 'raw' | 'fineFormula'>;

function SerialItemsList() {
  const { can, tenantId, context } = useTenant();
  const params = useSearchParams();
  const variantId = params.get('variantId') ?? '';
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  const [purityId, setPurityId] = useState('');
  const [sort, setSort] = useState('-createdAt');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const enabled = can('catalog.read') && context.features.includes('serialized_items');
  const filters = { q: debounced, status, purityId, sort, variantId };
  const pager = useCursorPagination(JSON.stringify(filters));
  const items = useTenantQuery<Page<Row>>(
    ['serial-items'],
    '/v1/admin/serial-items',
    { ...filters, cursor: pager.cursor, limit: 25 },
    enabled,
  );
  const purities = useTenantQuery<{ items: PurityDefinition[] }>(
    ['purities'],
    '/v1/admin/jewellery/purities',
    undefined,
    enabled,
  );
  if (!enabled) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="Serialized items"
        description="Physical pieces with their own actual measurements and HUID. Stock and availability arrive with Inventory (Phase 04)."
      />
      {variantId && (
        <Card>
          <span className="uc-row">
            Showing pieces of one variant. <Link href={`/t/${tenantId}/serial-items`}>Show all</Link>
          </span>
        </Card>
      )}
      <Card>
        <div className="uc-filters" role="search">
          <TextField
            label="Search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Tag, HUID, SKU or product"
          />
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: '', label: 'Any' },
              { value: 'active', label: 'Active' },
              { value: 'pending_review', label: 'Pending review' },
              { value: 'retired', label: 'Retired' },
            ]}
          />
          <SelectField
            label="Purity"
            value={purityId}
            onChange={(e) => setPurityId(e.target.value)}
            options={[
              { value: '', label: 'Any' },
              ...(purities.data?.items ?? []).map((p) => ({ value: p.id, label: `${p.metal} ${p.label}` })),
            ]}
          />
          <SelectField
            label="Sort"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            options={[
              { value: '-createdAt', label: 'Newest' },
              { value: 'createdAt', label: 'Oldest' },
              { value: 'serialTag', label: 'Tag' },
              { value: '-grossG', label: 'Heaviest' },
              { value: 'grossG', label: 'Lightest' },
            ]}
          />
        </div>
        <DataTable
          caption="Serialized items"
          rows={items.data?.items}
          isLoading={items.isLoading}
          error={items.error}
          onRetry={() => void items.refetch()}
          rowKey={(i) => i.id}
          pagination={pager.controls(items.data?.nextCursor)}
          empty={
            <EmptyState
              title={debounced || status || purityId ? 'No pieces match' : 'No serialized pieces yet'}
              description="Add pieces from a jewellery product’s measurements card."
            />
          }
          columns={[
            {
              key: 'tag',
              header: 'Tag',
              render: (i) => (
                <Link href={`/t/${tenantId}/serial-items/${i.id}`} className="uc-mono">
                  {i.serialTag}
                </Link>
              ),
            },
            {
              key: 'huid',
              header: 'HUID',
              render: (i) =>
                i.huid ? <span className="uc-mono">{i.huid}</span> : <span className="uc-muted">—</span>,
            },
            {
              key: 'product',
              header: 'Product / SKU',
              render: (i) => (
                <>
                  {i.productTitle}
                  <br />
                  <span className="uc-mono uc-muted">{i.sku}</span>
                </>
              ),
            },
            { key: 'purity', header: 'Purity', render: (i) => `${i.metal} ${i.purity.label}` },
            { key: 'gross', header: 'Gross', render: (i) => grams(i.grossG) },
            { key: 'net', header: 'Net', render: (i) => grams(i.netG) },
            { key: 'fine', header: 'Fine', render: (i) => grams(i.fineG) },
            {
              key: 'status',
              header: 'Status',
              render: (i) => (
                <>
                  {<StatusBadge status={i.status} />}{' '}
                  {i.checks.some((c) => c.severity === 'warning') && <Badge tone="warning">check</Badge>}
                </>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}

export default function SerialItemsPage() {
  return (
    <Suspense>
      <SerialItemsList />
    </Suspense>
  );
}
