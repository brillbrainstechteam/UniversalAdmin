'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { OpsHealth } from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  apiRequest,
  errorMessage,
  formatDateTime,
  useToast,
} from '@uc/ui';
import { usePlatformMe, usePlatformQuery } from '../../../lib/platform';

interface Dead {
  id: string;
  tenantId: string | null;
  eventType: string;
  attempts: number;
  lastError: string | null;
  occurredAt: string;
}
const TONE = { ok: 'success', warn: 'warning', alert: 'danger' } as const;

export default function PlatformOperationsPage() {
  const me = usePlatformMe();
  const qc = useQueryClient();
  const toast = useToast();
  const enabled = me.can('platform.tenants.read');
  const health = usePlatformQuery<OpsHealth>(
    ['ops', 'health'],
    '/v1/platform/operations/health',
    undefined,
    enabled,
  );
  const dead = usePlatformQuery<{ items: Dead[] }>(
    ['ops', 'dead'],
    '/v1/platform/operations/dead-events',
    undefined,
    enabled,
  );
  const replay = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/v1/platform/operations/dead-events/${id}/replay`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['p', 'ops'] });
      toast('Event queued for publishing again');
    },
  });
  if (!enabled) return <ForbiddenState />;
  if (health.error) return <ErrorState error={health.error} onRetry={() => void health.refetch()} />;
  if (!health.data) return <LoadingState />;
  return (
    <>
      <PageHeader
        title="Operations"
        description={`Platform-wide event pipeline and webhook health. Generated ${formatDateTime(health.data.generatedAt)}.`}
      />
      <Card title="Health">
        <DataTable
          caption="Platform health"
          rows={health.data.checks}
          rowKey={(c) => c.key}
          empty={<EmptyState title="No checks" />}
          columns={[
            { key: 'l', header: 'Check', render: (c) => c.label },
            {
              key: 'v',
              header: 'Now',
              render: (c) => (
                <span className="uc-mono">{c.unit === 'minutes' ? `${c.value} min` : c.value}</span>
              ),
            },
            { key: 's', header: 'Status', render: (c) => <Badge tone={TONE[c.status]}>{c.status}</Badge> },
            {
              key: 't',
              header: 'Thresholds',
              render: (c) => <span className="uc-muted">{c.thresholds}</span>,
            },
          ]}
        />
      </Card>
      <Card title="Dead events">
        <p className="uc-muted">
          Events the relay gave up on. Replaying is safe: every consumer ignores an event id it has already
          processed.
        </p>
        <DataTable
          caption="Dead events"
          rows={dead.data?.items}
          isLoading={dead.isLoading}
          error={dead.error}
          rowKey={(e) => e.id}
          empty={<EmptyState title="No dead events" />}
          columns={[
            { key: 'w', header: 'When', render: (e) => formatDateTime(e.occurredAt) },
            { key: 't', header: 'Event', render: (e) => e.eventType },
            {
              key: 'm',
              header: 'Merchant',
              render: (e) => <span className="uc-mono">{e.tenantId?.slice(0, 8) ?? 'platform'}</span>,
            },
            { key: 'a', header: 'Attempts', render: (e) => e.attempts },
            { key: 'r', header: 'Last error', render: (e) => e.lastError ?? '—' },
            {
              key: 'x',
              header: 'Actions',
              render: (e) =>
                me.can('platform.tenants.manage') && (
                  <Button
                    size="sm"
                    loading={replay.isPending && replay.variables === e.id}
                    onClick={() => replay.mutate(e.id)}
                  >
                    Replay
                  </Button>
                ),
            },
          ]}
        />
        {replay.error && <Alert tone="danger">{errorMessage(replay.error)}</Alert>}
      </Card>
    </>
  );
}
