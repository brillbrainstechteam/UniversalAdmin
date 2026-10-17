'use client';

import type { AuditEvent, Page, TenantSummary } from '@uc/contracts';
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
import { useState } from 'react';
import { usePlatformMe, usePlatformQuery } from '../../../lib/platform';

export default function PlatformAuditPage() {
  const me = usePlatformMe();
  const [tenantId, setTenantId] = useState('');
  const [action, setAction] = useState('');
  const filters = { tenantId, action: action.trim() };
  const pager = useCursorPagination(JSON.stringify(filters));
  const tenants = usePlatformQuery<Page<TenantSummary>>(
    ['tenants', 'all'],
    '/v1/platform/tenants',
    { limit: 100, sort: 'displayName' },
    me.can('platform.tenants.read'),
  );
  const events = usePlatformQuery<Page<AuditEvent>>(
    ['audit'],
    '/v1/platform/audit-events',
    { ...filters, cursor: pager.cursor, limit: 50 },
    me.can('platform.audit.read'),
  );
  if (!me.can('platform.audit.read')) return <ForbiddenState />;
  const tenantName = (id: string | null) =>
    id ? (tenants.data?.items.find((t) => t.id === id)?.displayName ?? id) : 'Platform';

  return (
    <>
      <PageHeader
        title="Platform audit"
        description="Sign-ins, provisioning, suspensions, entitlement changes and all tenant audit events."
      />
      <Card>
        <div className="uc-filters" role="search">
          <SelectField
            label="Tenant"
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            options={[
              { value: '', label: 'All' },
              ...(tenants.data?.items ?? []).map((t) => ({ value: t.id, label: t.displayName })),
            ]}
          />
          <TextField
            label="Action"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="e.g. tenant.suspended"
          />
        </div>
        <DataTable
          caption="Platform audit events"
          rows={events.data?.items}
          isLoading={events.isLoading}
          error={events.error}
          onRetry={() => void events.refetch()}
          rowKey={(e) => e.id}
          pagination={pager.controls(events.data?.nextCursor)}
          empty={<EmptyState title="No audit events match these filters" />}
          columns={[
            { key: 'when', header: 'When', render: (e) => formatDateTime(e.createdAt) },
            { key: 'tenant', header: 'Tenant', render: (e) => tenantName(e.tenantId) },
            { key: 'action', header: 'Action', render: (e) => <span className="uc-mono">{e.action}</span> },
            { key: 'actor', header: 'Actor', render: (e) => `${e.actor?.email ?? '—'} (${e.actorType})` },
            { key: 'reason', header: 'Reason', render: (e) => e.reason ?? '—' },
          ]}
        />
      </Card>
    </>
  );
}
