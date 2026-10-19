'use client';

import type { Page, PriceQuote } from '@uc/contracts';
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
import { PricingTabs, money } from '../../../../../lib/pricing';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

type Summary = Pick<
  PriceQuote,
  'id' | 'channel' | 'origin' | 'status' | 'currency' | 'totalMinor' | 'createdAt' | 'expiresAt'
> & { lineCount: number };

export default function QuotesPage() {
  const { can, tenantId, context } = useTenant();
  const enabled = can('pricing.read') && context.features.includes('pricing');
  const tz = context.tenant.timezone;
  const [status, setStatus] = useState('');
  const pager = useCursorPagination(status);
  const list = useTenantQuery<Page<Summary>>(
    ['pricing', 'quotes'],
    '/v1/admin/pricing/quotes',
    { status, cursor: pager.cursor, limit: 25 },
    enabled,
  );
  if (!enabled) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="Price quotes"
        description="Immutable records of prices shown to staff and storefront visitors. Revalidating creates a new quote; the original never changes."
      />
      <PricingTabs />
      <Card>
        <div className="uc-filters" role="search">
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: '', label: 'Any' },
              { value: 'active', label: 'Active' },
              { value: 'expired', label: 'Expired' },
              { value: 'superseded', label: 'Superseded' },
            ]}
          />
        </div>
        <DataTable
          caption="Price quotes"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(r) => r.id}
          pagination={pager.controls(list.data?.nextCursor)}
          empty={<EmptyState title="No quotes" description="Create one from the calculator." />}
          columns={[
            {
              key: 'created',
              header: 'Created',
              render: (r) => (
                <Link href={`/t/${tenantId}/pricing/quotes/${r.id}`}>{formatDateTime(r.createdAt, tz)}</Link>
              ),
            },
            {
              key: 'origin',
              header: 'Origin',
              render: (r) => (r.origin === 'storefront' ? 'Storefront' : 'Admin'),
            },
            { key: 'channel', header: 'Channel', render: (r) => r.channel?.name ?? '—' },
            { key: 'lines', header: 'Lines', render: (r) => r.lineCount },
            {
              key: 'total',
              header: 'Total',
              render: (r) => <span className="uc-mono">{money(r.totalMinor, r.currency)}</span>,
            },
            { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            { key: 'exp', header: 'Valid until', render: (r) => formatDateTime(r.expiresAt, tz) },
          ]}
        />
      </Card>
    </>
  );
}
