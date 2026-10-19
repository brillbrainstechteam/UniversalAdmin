'use client';

import type { OrderSummary, Page } from '@uc/contracts';
import {
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
import { Suspense, useEffect, useState } from 'react';
import { ORIGIN_LABELS, OrdersTabs, Status } from '../../../../lib/orders';
import { money } from '../../../../lib/pricing';
import { useTenant, useTenantQuery } from '../../../../lib/tenant';

function OrdersList() {
  const { can, tenantId, context } = useTenant();
  const enabled = can('orders.read') && context.features.includes('orders');
  const tz = context.tenant.timezone;
  const [status, setStatus] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('');
  const [origin, setOrigin] = useState('');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const filters = { status, paymentStatus, origin, q: debounced };
  const pager = useCursorPagination(JSON.stringify(filters));
  const list = useTenantQuery<Page<OrderSummary>>(
    ['orders', 'list'],
    '/v1/admin/orders',
    { ...filters, cursor: pager.cursor, limit: 25 },
    enabled,
  );
  if (!enabled) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="Orders"
        description="Every total here was calculated by the server and frozen on the order. Payments are sandbox-only in this build."
        actions={
          can('orders.manage') && (
            <Link className="uc-btn" data-variant="primary" href={`/t/${tenantId}/orders/new`}>
              New order
            </Link>
          )
        }
      />
      <OrdersTabs />
      <Card>
        <div className="uc-filters" role="search">
          <TextField
            label="Search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Order number, customer name or email"
          />
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: '', label: 'Any' },
              { value: 'awaiting_approval', label: 'Awaiting approval' },
              { value: 'pending_payment', label: 'Pending payment' },
              { value: 'confirmed', label: 'Confirmed' },
              { value: 'on_hold', label: 'On hold' },
              { value: 'cancelled', label: 'Cancelled' },
            ]}
          />
          <SelectField
            label="Payment"
            value={paymentStatus}
            onChange={(e) => setPaymentStatus(e.target.value)}
            options={[
              { value: '', label: 'Any' },
              { value: 'unpaid', label: 'Unpaid (on account)' },
              { value: 'pending', label: 'Pending' },
              { value: 'paid', label: 'Paid' },
              { value: 'failed', label: 'Failed' },
              { value: 'refund_due', label: 'Refund due' },
            ]}
          />
          <SelectField
            label="Origin"
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            options={[
              { value: '', label: 'Any' },
              ...Object.entries(ORIGIN_LABELS).map(([value, label]) => ({ value, label })),
            ]}
          />
        </div>
        <DataTable
          caption="Orders"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(o) => o.id}
          pagination={pager.controls(list.data?.nextCursor)}
          empty={
            <EmptyState
              title="No orders"
              description="Orders from the storefront, staff and quotations appear here."
            />
          }
          columns={[
            {
              key: 'number',
              header: 'Order',
              render: (o) => (
                <Link href={`/t/${tenantId}/orders/${o.id}`} className="uc-mono">
                  {o.number}
                </Link>
              ),
            },
            { key: 'date', header: 'Created', render: (o) => formatDateTime(o.createdAt, tz) },
            { key: 'customer', header: 'Customer', render: (o) => `${o.contactName} · ${o.contactEmail}` },
            {
              key: 'origin',
              header: 'Origin',
              render: (o) => `${ORIGIN_LABELS[o.origin]}${o.channel ? ` · ${o.channel.name}` : ''}`,
            },
            { key: 'status', header: 'Status', render: (o) => <Status value={o.status} /> },
            { key: 'payment', header: 'Payment', render: (o) => <Status value={o.paymentStatus} /> },
            {
              key: 'total',
              header: 'Total',
              render: (o) => <span className="uc-mono">{money(o.totalMinor, o.currency)}</span>,
            },
          ]}
        />
      </Card>
    </>
  );
}

export default function OrdersPage() {
  return (
    <Suspense>
      <OrdersList />
    </Suspense>
  );
}
