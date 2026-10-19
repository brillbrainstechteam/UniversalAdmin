'use client';

import type { Page, Quotation } from '@uc/contracts';
import {
  Card,
  DataTable,
  EmptyState,
  ForbiddenState,
  PageHeader,
  SelectField,
  formatDateTime,
  useCursorPagination,
} from '@uc/ui';
import Link from 'next/link';
import { useState } from 'react';
import { OrdersTabs, Status } from '../../../../../lib/orders';
import { money } from '../../../../../lib/pricing';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

type Summary = Pick<
  Quotation,
  'id' | 'number' | 'status' | 'channel' | 'validUntil' | 'currency' | 'totalMinor' | 'createdAt'
> & { contactName: string };

export default function QuotationsPage() {
  const { can, tenantId, context } = useTenant();
  const enabled = can('orders.read') && context.features.includes('orders');
  const tz = context.tenant.timezone;
  const [status, setStatus] = useState('');
  const pager = useCursorPagination(status);
  const list = useTenantQuery<Page<Summary>>(
    ['orders', 'quotations'],
    '/v1/admin/quotations',
    { status, cursor: pager.cursor, limit: 25 },
    enabled,
  );
  if (!enabled) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="Quotations"
        description="Sending a quotation freezes its price until the validity date; an accepted quotation becomes an order at that price."
        actions={
          can('orders.manage') && (
            <Link className="uc-btn" data-variant="primary" href={`/t/${tenantId}/orders/quotations/new`}>
              New quotation
            </Link>
          )
        }
      />
      <OrdersTabs />
      <Card>
        <div className="uc-filters" role="search">
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: '', label: 'Any' },
              ...['draft', 'sent', 'accepted', 'converted', 'cancelled', 'expired'].map((s) => ({
                value: s,
                label: s,
              })),
            ]}
          />
        </div>
        <DataTable
          caption="Quotations"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(q) => q.id}
          pagination={pager.controls(list.data?.nextCursor)}
          empty={<EmptyState title="No quotations" />}
          columns={[
            {
              key: 'number',
              header: 'Quotation',
              render: (q) => (
                <Link href={`/t/${tenantId}/orders/quotations/${q.id}`} className="uc-mono">
                  {q.number}
                </Link>
              ),
            },
            { key: 'customer', header: 'Customer', render: (q) => q.contactName },
            { key: 'status', header: 'Status', render: (q) => <Status value={q.status} /> },
            {
              key: 'total',
              header: 'Frozen total',
              render: (q) =>
                q.totalMinor && q.currency ? (
                  <span className="uc-mono">{money(q.totalMinor, q.currency)}</span>
                ) : (
                  '— (draft)'
                ),
            },
            { key: 'valid', header: 'Valid until', render: (q) => formatDateTime(q.validUntil, tz) },
            { key: 'created', header: 'Created', render: (q) => formatDateTime(q.createdAt, tz) },
          ]}
        />
      </Card>
    </>
  );
}
