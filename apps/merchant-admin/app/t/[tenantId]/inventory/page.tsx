'use client';

import {
  qtyIsZero,
  type ChannelStockLocations,
  type InventorySummary,
  type Page,
  type StockLevel,
} from '@uc/contracts';
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  SelectField,
  TextField,
  useCursorPagination,
} from '@uc/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { InventoryTabs, qtyText, useLocations } from '../../../../lib/inventory';
import { useTenant, useTenantQuery } from '../../../../lib/tenant';

export default function InventoryPage() {
  const { can, tenantId, context } = useTenant();
  const enabled = can('inventory.read') && context.features.includes('inventory');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [locationId, setLocationId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [stock, setStock] = useState('all');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const filters = { q: debounced, locationId, channelId: locationId ? '' : channelId, stock };
  const pager = useCursorPagination(JSON.stringify(filters));
  const summary = useTenantQuery<InventorySummary>(
    ['inventory', 'summary'],
    '/v1/admin/inventory/summary',
    undefined,
    enabled,
  );
  const levels = useTenantQuery<Page<StockLevel>>(
    ['inventory', 'levels'],
    '/v1/admin/inventory/levels',
    { ...filters, cursor: pager.cursor, limit: 25 },
    enabled,
  );
  const locations = useLocations(enabled);
  const channels = useTenantQuery<{ items: ChannelStockLocations[] }>(
    ['inventory', 'channels'],
    '/v1/admin/inventory/channels',
    undefined,
    enabled,
  );
  if (!enabled) return <ForbiddenState />;
  const s = summary.data;
  return (
    <>
      <PageHeader
        title="Inventory"
        description="Stock on hand, holds and available-to-promise (ATP = sellable on hand − reserved − committed − buffer). Every change is recorded in the append-only ledger."
      />
      <InventoryTabs />
      {summary.isLoading ? (
        <LoadingState rows={1} />
      ) : summary.error ? (
        <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
      ) : s ? (
        <section className="uc-grid" aria-label="Inventory summary">
          {(
            [
              ['Tracked variants', s.trackedVariants, null],
              ['Low stock', s.lowStock, 'low'],
              ['Out of stock', s.outOfStock, 'out'],
              ['Active holds', s.activeHolds, 'reservations'],
              ['Committed', s.committedReservations, 'reservations'],
              ['Transfers in transit', s.transfersInTransit, 'transfers'],
              ['Open issues', s.openIssues, 'issues'],
            ] as const
          ).map(([label, value, link]) => (
            <div key={label} className="uc-card uc-stat">
              <span className="uc-muted">{label}</span>
              <strong>{value}</strong>
              {link === 'low' || link === 'out' ? (
                <button
                  type="button"
                  className="uc-btn"
                  data-size="sm"
                  data-variant="ghost"
                  onClick={() => setStock(link)}
                >
                  Show
                </button>
              ) : link ? (
                <Link href={`/t/${tenantId}/inventory/${link}`}>Open</Link>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      <Card>
        <div className="uc-filters" role="search">
          <TextField
            label="Search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="SKU, product or variant"
          />
          <SelectField
            label="Location"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            options={[{ value: '', label: 'All my locations' }, ...locations.options]}
          />
          <SelectField
            label="Channel"
            value={channelId}
            disabled={!!locationId}
            onChange={(e) => setChannelId(e.target.value)}
            options={[
              { value: '', label: 'Any channel' },
              ...(channels.data?.items ?? []).map((c) => ({ value: c.channelId, label: c.name })),
            ]}
          />
          <SelectField
            label="Stock"
            value={stock}
            onChange={(e) => setStock(e.target.value)}
            options={[
              { value: 'all', label: 'All' },
              { value: 'in', label: 'Available' },
              { value: 'low', label: 'Low stock' },
              { value: 'out', label: 'Out of stock' },
            ]}
          />
        </div>
        <DataTable
          caption="Stock levels"
          rows={levels.data?.items}
          isLoading={levels.isLoading}
          error={levels.error}
          onRetry={() => void levels.refetch()}
          rowKey={(r) => r.variantId}
          pagination={pager.controls(levels.data?.nextCursor)}
          empty={
            <EmptyState
              title={debounced || stock !== 'all' ? 'No variants match' : 'No variants yet'}
              description="Variants appear here once products exist; receive stock from a variant’s stock page."
            />
          }
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
                  <span className="uc-muted">
                    {r.productTitle}
                    {r.variantTitle ? ` · ${r.variantTitle}` : ''}
                  </span>
                </>
              ),
            },
            {
              key: 'tracking',
              header: 'Tracking',
              render: (r) => (r.tracking === 'serial' ? <Badge tone="info">pieces</Badge> : r.unit),
            },
            { key: 'onHand', header: 'On hand', render: (r) => qtyText(r.onHand, r.unit) },
            { key: 'reserved', header: 'Held', render: (r) => qtyText(r.reserved, r.unit) },
            { key: 'committed', header: 'Committed', render: (r) => qtyText(r.committed, r.unit) },
            {
              key: 'unsellable',
              header: 'Damaged / quarantine',
              render: (r) => qtyText(r.unsellable, r.unit),
            },
            { key: 'inTransit', header: 'Incoming', render: (r) => qtyText(r.inTransit, r.unit) },
            {
              key: 'atp',
              header: 'ATP',
              render: (r) => (
                <span className="uc-row">
                  <strong>{qtyText(r.atp, r.unit)}</strong>
                  {qtyIsZero(r.atp) ? (
                    <Badge tone="danger">out</Badge>
                  ) : r.lowStock ? (
                    <Badge tone="warning">low</Badge>
                  ) : null}
                </span>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}
