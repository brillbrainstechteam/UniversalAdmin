'use client';

import type { Page, Rfq } from '@uc/contracts';
import {
  Badge,
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
import { CompaniesTabs, RFQ_TONE } from '../../../../../lib/companies';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

type Summary = Pick<Rfq, 'id' | 'number' | 'status' | 'company' | 'quotationId' | 'createdAt'> & {
  lineCount: number;
  buyerName: string;
};

export default function RfqInboxPage() {
  const { can, tenantId, context } = useTenant();
  const enabled = can('companies.read') && context.features.includes('b2b_companies');
  const [status, setStatus] = useState('submitted');
  const pager = useCursorPagination(status);
  const list = useTenantQuery<Page<Summary>>(
    ['companies', 'rfqs'],
    '/v1/admin/rfqs',
    { status, cursor: pager.cursor, limit: 25 },
    enabled,
  );
  if (!enabled) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="RFQ inbox"
        description="Requests for quotation from company buyers. Answer in the thread and send a quotation frozen until its validity date."
      />
      <CompaniesTabs />
      <Card>
        <div className="uc-filters" role="search">
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: '', label: 'Any' },
              ...['submitted', 'quoted', 'accepted', 'declined', 'expired'].map((s) => ({
                value: s,
                label: s,
              })),
            ]}
          />
        </div>
        <DataTable
          caption="RFQs"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(r) => r.id}
          pagination={pager.controls(list.data?.nextCursor)}
          empty={<EmptyState title="No RFQs" />}
          columns={[
            {
              key: 'number',
              header: 'RFQ',
              render: (r) => (
                <Link href={`/t/${tenantId}/companies/rfqs/${r.id}`} className="uc-mono">
                  {r.number}
                </Link>
              ),
            },
            { key: 'company', header: 'Company', render: (r) => r.company.name },
            { key: 'buyer', header: 'Buyer', render: (r) => r.buyerName },
            { key: 'lines', header: 'Lines', render: (r) => r.lineCount },
            {
              key: 'status',
              header: 'Status',
              render: (r) => <Badge tone={RFQ_TONE[r.status]}>{r.status}</Badge>,
            },
            {
              key: 'when',
              header: 'Received',
              render: (r) => formatDateTime(r.createdAt, context.tenant.timezone),
            },
          ]}
        />
      </Card>
    </>
  );
}
