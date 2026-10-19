'use client';

import { useQuery } from '@tanstack/react-query';
import type { Page } from '@uc/contracts';
import { Badge, Card, DataTable, EmptyState, PageHeader, formatDateTime, useCursorPagination } from '@uc/ui';
import Link from 'next/link';
import { buyerApi } from '../../../lib/buyer';

interface RfqRow {
  id: string;
  number: string;
  status: string;
  lineCount: number;
  buyerName: string;
  quotationId: string | null;
  createdAt: string;
}

const TONE: Record<string, 'success' | 'danger' | 'warning' | 'info' | undefined> = {
  submitted: 'warning',
  quoted: 'info',
  accepted: 'success',
  declined: 'danger',
};

export default function RfqsPage() {
  const pager = useCursorPagination('');
  const list = useQuery({
    queryKey: ['rfqs', pager.cursor],
    queryFn: () =>
      buyerApi<Page<RfqRow>>(
        `/rfqs?${new URLSearchParams({ limit: '25', ...(pager.cursor ? { cursor: pager.cursor } : {}) })}`,
      ),
  });
  return (
    <>
      <PageHeader
        title="Requests for quotation"
        description="Ask your supplier to quote custom quantities or designs. Quotes arrive under Quotations."
        actions={
          <Link href="/rfqs/new" className="uc-btn" data-variant="primary">
            New request
          </Link>
        }
      />
      <Card>
        <DataTable
          caption="Requests for quotation"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          rowKey={(r) => r.id}
          pagination={pager.controls(list.data?.nextCursor)}
          empty={<EmptyState title="No requests yet" />}
          columns={[
            {
              key: 'number',
              header: 'Request',
              render: (r) => (
                <Link href={`/rfqs/${r.id}`} className="uc-mono">
                  {r.number}
                </Link>
              ),
            },
            { key: 'date', header: 'Sent', render: (r) => formatDateTime(r.createdAt) },
            { key: 'by', header: 'By', render: (r) => r.buyerName },
            { key: 'lines', header: 'Lines', render: (r) => r.lineCount },
            {
              key: 'status',
              header: 'Status',
              render: (r) => <Badge tone={TONE[r.status]}>{r.status}</Badge>,
            },
          ]}
        />
      </Card>
    </>
  );
}
