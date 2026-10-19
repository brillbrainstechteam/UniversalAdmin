'use client';

import { useQuery } from '@tanstack/react-query';
import type { OrderSummary, Page } from '@uc/contracts';
import { Badge, DataTable, EmptyState, formatDateTime, useCursorPagination } from '@uc/ui';
import Link from 'next/link';
import { STATUS_LABELS, buyerApi, useBuyer } from './buyer';

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'confirmed'
      ? 'success'
      : status === 'cancelled'
        ? undefined
        : status === 'on_hold'
          ? 'danger'
          : 'warning';
  return <Badge tone={tone}>{STATUS_LABELS[status] ?? status}</Badge>;
}

/** Company orders (the API limits them to the buyer's locations). */
export function OrderTable({ status, caption }: { status?: string; caption: string }) {
  const { money } = useBuyer();
  const pager = useCursorPagination(status ?? '');
  const list = useQuery({
    queryKey: ['orders', status ?? '', pager.cursor],
    queryFn: () =>
      buyerApi<Page<OrderSummary>>(
        `/orders?${new URLSearchParams({ limit: '25', ...(status ? { status } : {}), ...(pager.cursor ? { cursor: pager.cursor } : {}) })}`,
      ),
  });
  return (
    <DataTable
      caption={caption}
      rows={list.data?.items}
      isLoading={list.isLoading}
      error={list.error}
      rowKey={(o) => o.id}
      pagination={pager.controls(list.data?.nextCursor)}
      empty={<EmptyState title="No orders" />}
      columns={[
        {
          key: 'number',
          header: 'Order',
          render: (o) => (
            <Link href={`/orders/${o.id}`} className="uc-mono">
              {o.number}
            </Link>
          ),
        },
        { key: 'date', header: 'Placed', render: (o) => formatDateTime(o.createdAt) },
        { key: 'status', header: 'Status', render: (o) => <StatusBadge status={o.status} /> },
        {
          key: 'total',
          header: 'Total',
          render: (o) => <span className="uc-mono">{money(o.totalMinor)}</span>,
        },
      ]}
    />
  );
}
