'use client';

import type { CustomerSummary, Page } from '@uc/contracts';
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
import { useEffect, useState } from 'react';
import { useTenant, useTenantQuery } from '../../../../lib/tenant';

export default function CustomersPage() {
  const { can, tenantId, context } = useTenant();
  const enabled = can('customers.read') && context.features.includes('customers');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const pager = useCursorPagination(`${debounced}|${status}`);
  const list = useTenantQuery<Page<CustomerSummary>>(
    ['customers', 'list'],
    '/v1/admin/customers',
    { q: debounced || undefined, status: status || undefined, cursor: pager.cursor, limit: 25 },
    enabled,
  );
  if (!enabled) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="Customers"
        description="Shoppers with an account on your online store. E-mail addresses are not verified until an e-mail connector is set up."
      />
      <Card>
        <div className="uc-filters" role="search">
          <TextField
            label="Search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name or e-mail"
          />
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: '', label: 'Any' },
              { value: 'active', label: 'Active' },
              { value: 'disabled', label: 'Disabled' },
            ]}
          />
        </div>
        <DataTable
          caption="Customers"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          rowKey={(c) => c.id}
          pagination={pager.controls(list.data?.nextCursor)}
          empty={
            <EmptyState
              title="No customers yet"
              description="Customers appear when shoppers register on your store."
            />
          }
          columns={[
            {
              key: 'name',
              header: 'Customer',
              render: (c) => (
                <Link href={`/t/${tenantId}/customers/${c.id}`}>
                  {c.displayName} {c.isDemo && <Badge>demo</Badge>}
                </Link>
              ),
            },
            { key: 'email', header: 'E-mail', render: (c) => c.email },
            { key: 'orders', header: 'Orders', render: (c) => c.orderCount },
            {
              key: 'status',
              header: 'Status',
              render: (c) => <Badge tone={c.status === 'active' ? 'success' : undefined}>{c.status}</Badge>,
            },
            {
              key: 'since',
              header: 'Joined',
              render: (c) => formatDateTime(c.createdAt, context.tenant.timezone),
            },
          ]}
        />
      </Card>
    </>
  );
}
