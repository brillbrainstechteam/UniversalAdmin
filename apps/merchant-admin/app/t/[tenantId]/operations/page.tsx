'use client';

import type { OpsHealth } from '@uc/contracts';
import {
  Alert,
  Badge,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  formatDateTime,
} from '@uc/ui';
import { useTenant, useTenantQuery } from '../../../../lib/tenant';

interface Provider {
  kind: string;
  key: string;
  name: string;
  status: string;
  capabilities: string[];
  detail: string;
}

const TONE = { ok: 'success', warn: 'warning', alert: 'danger' } as const;

export default function OperationsPage() {
  const { can, context } = useTenant();
  const enabled = can('operations.read');
  const health = useTenantQuery<OpsHealth>(
    ['operations', 'health'],
    '/v1/admin/operations/health',
    undefined,
    enabled,
  );
  const providers = useTenantQuery<{ items: Provider[] }>(
    ['operations', 'providers'],
    '/v1/admin/operations/providers',
    undefined,
    enabled && can('integrations.read'),
  );
  if (!enabled) return <ForbiddenState />;
  if (health.error) return <ErrorState error={health.error} onRetry={() => void health.refetch()} />;
  if (!health.data) return <LoadingState />;
  const h = health.data;
  const unit = (u: string, v: number) =>
    u === 'percent' ? `${v}%` : u === 'minutes' ? `${v} min` : String(v);
  return (
    <>
      <PageHeader
        title="Operations"
        description={`Live checks on events, webhooks, ERP sync, reconciliation, rates and payments. Generated ${formatDateTime(h.generatedAt, context.tenant.timezone)}.`}
      />
      <Alert tone={h.status === 'ok' ? 'success' : h.status === 'warn' ? 'warning' : 'danger'}>
        {h.status === 'ok'
          ? 'All checks are within their thresholds.'
          : `${h.checks.filter((c) => c.status !== 'ok').length} check(s) need attention.`}
      </Alert>
      <Card>
        <DataTable
          caption="Health checks"
          rows={h.checks}
          rowKey={(c) => c.key}
          empty={<EmptyState title="No checks" />}
          columns={[
            { key: 'l', header: 'Check', render: (c) => c.label },
            {
              key: 'v',
              header: 'Now',
              render: (c) => <span className="uc-mono">{unit(c.unit, c.value)}</span>,
            },
            { key: 's', header: 'Status', render: (c) => <Badge tone={TONE[c.status]}>{c.status}</Badge> },
            {
              key: 't',
              header: 'Thresholds',
              render: (c) => <span className="uc-muted">{c.thresholds}</span>,
            },
            { key: 'd', header: 'Note', render: (c) => c.detail ?? '—' },
          ]}
        />
      </Card>
      {providers.data && (
        <Card title="Payment, shipping and notification providers">
          <DataTable
            caption="Providers"
            rows={providers.data.items}
            rowKey={(p) => `${p.kind}-${p.key}`}
            empty={<EmptyState title="No providers" />}
            columns={[
              { key: 'k', header: 'Kind', render: (p) => p.kind },
              { key: 'n', header: 'Provider', render: (p) => p.name },
              {
                key: 's',
                header: 'Status',
                render: (p) => (
                  <Badge tone={p.status === 'sandbox' ? 'warning' : undefined}>
                    {p.status === 'blocked' ? 'needs account' : p.status}
                  </Badge>
                ),
              },
              { key: 'c', header: 'Capabilities', render: (p) => p.capabilities.join(', ') },
              { key: 'd', header: 'Detail', render: (p) => <span className="uc-muted">{p.detail}</span> },
            ]}
          />
        </Card>
      )}
    </>
  );
}
