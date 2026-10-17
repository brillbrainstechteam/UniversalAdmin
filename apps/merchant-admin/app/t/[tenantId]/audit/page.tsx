'use client';

import type { AuditEvent, Page } from '@uc/contracts';
import {
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  ForbiddenState,
  PageHeader,
  SelectField,
  TextField,
  formatDateTime,
  useCursorPagination,
} from '@uc/ui';
import { useState } from 'react';
import { useTenant, useTenantQuery } from '../../../../lib/tenant';

const ENTITY_TYPES = ['', 'tenant', 'store', 'channel', 'location', 'membership', 'invitation', 'role'];

export default function AuditPage() {
  const { can, context } = useTenant();
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const filters = {
    entityType,
    action: action.trim(),
    from: from ? new Date(`${from}T00:00:00`).toISOString() : '',
    to: to ? new Date(`${to}T23:59:59.999`).toISOString() : '',
  };
  const pager = useCursorPagination(JSON.stringify(filters));
  const events = useTenantQuery<Page<AuditEvent>>(
    ['audit'],
    '/v1/admin/audit-events',
    { ...filters, cursor: pager.cursor, limit: 50 },
    can('audit.read'),
  );
  if (!can('audit.read')) return <ForbiddenState />;
  const tz = context.tenant.timezone;

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Append-only record of sensitive changes. Secrets and credentials are redacted before storage."
      />
      <Card>
        <div className="uc-filters" role="search">
          <SelectField
            label="Entity"
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            options={ENTITY_TYPES.map((t) => ({ value: t, label: t || 'All entities' }))}
          />
          <TextField
            label="Action"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="e.g. member.updated"
          />
          <TextField label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <TextField label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <DataTable
          caption="Audit events"
          rows={events.data?.items}
          isLoading={events.isLoading}
          error={events.error}
          onRetry={() => void events.refetch()}
          rowKey={(e) => e.id}
          pagination={pager.controls(events.data?.nextCursor)}
          empty={<EmptyState title="No audit events match these filters" />}
          columns={[
            { key: 'when', header: `When (${tz})`, render: (e) => formatDateTime(e.createdAt, tz) },
            { key: 'action', header: 'Action', render: (e) => <span className="uc-mono">{e.action}</span> },
            { key: 'entity', header: 'Entity', render: (e) => e.entityType },
            { key: 'actor', header: 'Actor', render: (e) => e.actor?.email ?? e.actorType },
            {
              key: 'reason',
              header: 'Reason',
              render: (e) => e.reason ?? <span className="uc-muted">—</span>,
            },
            {
              key: 'details',
              header: 'Details',
              render: (e) => (
                <Button size="sm" onClick={() => setSelected(e)}>
                  View<span className="uc-sr-only"> {e.action}</span>
                </Button>
              ),
            },
          ]}
        />
      </Card>
      {selected && (
        <Dialog
          open
          title={selected.action}
          onClose={() => setSelected(null)}
          footer={<Button onClick={() => setSelected(null)}>Close</Button>}
        >
          <dl className="uc-stack" style={{ margin: 0 }}>
            <div>
              <dt className="uc-muted">When</dt>
              <dd>{formatDateTime(selected.createdAt, tz)}</dd>
            </div>
            <div>
              <dt className="uc-muted">Actor</dt>
              <dd>
                {selected.actor?.email ?? selected.actorType} ({selected.actorType})
              </dd>
            </div>
            <div>
              <dt className="uc-muted">Entity</dt>
              <dd className="uc-mono">
                {selected.entityType} {selected.entityId}
              </dd>
            </div>
            <div>
              <dt className="uc-muted">Correlation ID</dt>
              <dd className="uc-mono">{selected.correlationId ?? '—'}</dd>
            </div>
            <div>
              <dt className="uc-muted">Before</dt>
              <dd>
                <pre className="uc-code-box">{JSON.stringify(selected.oldValues, null, 2)}</pre>
              </dd>
            </div>
            <div>
              <dt className="uc-muted">After</dt>
              <dd>
                <pre className="uc-code-box">{JSON.stringify(selected.newValues, null, 2)}</pre>
              </dd>
            </div>
          </dl>
        </Dialog>
      )}
    </>
  );
}
