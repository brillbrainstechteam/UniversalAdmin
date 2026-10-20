'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { WEBHOOK_EVENT_TYPES, type Page, type WebhookEndpoint } from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  ForbiddenState,
  PageHeader,
  TextField,
  errorMessage,
  formatDateTime,
  useToast,
} from '@uc/ui';
import { useState } from 'react';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

interface Delivery {
  id: string;
  eventType: string;
  source: string;
  status: string;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
}

export default function WebhooksPage() {
  const { api, can, tenantId, context } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const tz = context.tenant.timezone;
  const enabled = can('webhooks.manage');
  const list = useTenantQuery<{ items: WebhookEndpoint[] }>(
    ['webhooks'],
    '/v1/admin/webhooks',
    undefined,
    enabled,
  );
  const [form, setForm] = useState<{ name: string; url: string; events: string[] } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const deliveries = useTenantQuery<Page<Delivery>>(
    ['webhooks', 'deliveries', open],
    `/v1/admin/webhooks/${open}/deliveries`,
    { limit: 20 },
    enabled && !!open,
  );
  const refresh = () => void qc.invalidateQueries({ queryKey: ['t', tenantId, 'webhooks'] });
  const create = useMutation({
    mutationFn: () =>
      api<{ secret: string }>('/v1/admin/webhooks', {
        method: 'POST',
        body: { name: form!.name.trim(), url: form!.url.trim(), eventTypes: form!.events },
      }),
    onSuccess: (r) => {
      setForm(null);
      setSecret(r.secret);
      refresh();
    },
  });
  const action = useMutation({
    mutationFn: async (v: {
      id: string;
      kind: 'rotate' | 'test' | 'delete' | 'toggle';
      ep?: WebhookEndpoint;
    }) => {
      if (v.kind === 'rotate')
        setSecret(
          (await api<{ secret: string }>(`/v1/admin/webhooks/${v.id}/rotate-secret`, { method: 'POST' }))
            .secret,
        );
      if (v.kind === 'test') await api(`/v1/admin/webhooks/${v.id}/test`, { method: 'POST' });
      if (v.kind === 'delete') await api(`/v1/admin/webhooks/${v.id}`, { method: 'DELETE' });
      if (v.kind === 'toggle' && v.ep)
        await api(`/v1/admin/webhooks/${v.id}`, {
          method: 'PUT',
          body: {
            name: v.ep.name,
            url: v.ep.url,
            eventTypes: v.ep.eventTypes,
            status: v.ep.status === 'active' ? 'disabled' : 'active',
            version: v.ep.version,
          },
        });
    },
    onSuccess: (_d, v) => {
      refresh();
      if (v.kind === 'test') toast('Test delivery queued');
    },
  });
  const replay = useMutation({
    mutationFn: (id: string) => api(`/v1/admin/webhook-deliveries/${id}/replay`, { method: 'POST' }),
    onSuccess: () => {
      refresh();
      toast('Delivery queued again');
    },
  });
  if (!enabled) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="Webhooks"
        description="Send signed event notifications to your own systems. Failed deliveries are retried with backoff and can be replayed."
        actions={
          <Button
            variant="primary"
            onClick={() => setForm({ name: '', url: 'https://', events: ['OrderConfirmed'] })}
          >
            Add endpoint
          </Button>
        }
      />
      {secret && (
        <Alert tone="warning" title="Signing secret — copy it now, it is not shown again">
          <code className="uc-mono">{secret}</code>
          <p className="uc-muted">
            Verify each request: HMAC-SHA256 of <code>t.body</code> with this secret must equal{' '}
            <code>v1</code> in the <code>X-UC-Signature</code> header. Use <code>X-UC-Event-Id</code> to
            ignore duplicates.
          </p>
        </Alert>
      )}
      <Card>
        <DataTable
          caption="Webhook endpoints"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          rowKey={(e) => e.id}
          empty={<EmptyState title="No endpoints yet" />}
          columns={[
            {
              key: 'n',
              header: 'Endpoint',
              render: (e) => (
                <>
                  <strong>{e.name}</strong>
                  <div className="uc-mono uc-muted">{e.url}</div>
                </>
              ),
            },
            { key: 'ev', header: 'Events', render: (e) => e.eventTypes.join(', ') },
            {
              key: 's',
              header: 'Status',
              render: (e) => (
                <>
                  <Badge tone={e.status === 'active' ? 'success' : undefined}>{e.status}</Badge>
                  {e.consecutiveFailures > 0 && (
                    <Badge tone="warning">{e.consecutiveFailures} failures</Badge>
                  )}
                </>
              ),
            },
            {
              key: 'l',
              header: 'Last success',
              render: (e) => (e.lastSuccessAt ? formatDateTime(e.lastSuccessAt, tz) : '—'),
            },
            {
              key: 'a',
              header: 'Actions',
              render: (e) => (
                <div className="uc-row" style={{ flexWrap: 'wrap' }}>
                  <Button size="sm" onClick={() => setOpen(open === e.id ? null : e.id)}>
                    {open === e.id ? 'Hide deliveries' : 'Deliveries'}
                  </Button>
                  <Button size="sm" onClick={() => action.mutate({ id: e.id, kind: 'test' })}>
                    Send test
                  </Button>
                  <Button size="sm" onClick={() => action.mutate({ id: e.id, kind: 'rotate' })}>
                    Rotate secret
                  </Button>
                  <Button size="sm" onClick={() => action.mutate({ id: e.id, kind: 'toggle', ep: e })}>
                    {e.status === 'active' ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => action.mutate({ id: e.id, kind: 'delete' })}
                  >
                    Remove
                  </Button>
                </div>
              ),
            },
          ]}
        />
        {action.error && <Alert tone="danger">{errorMessage(action.error)}</Alert>}
      </Card>
      {open && (
        <Card title="Recent deliveries">
          <DataTable
            caption="Recent deliveries"
            rows={deliveries.data?.items}
            isLoading={deliveries.isLoading}
            error={deliveries.error}
            rowKey={(d) => d.id}
            empty={<EmptyState title="No deliveries yet" />}
            columns={[
              { key: 'w', header: 'When', render: (d) => formatDateTime(d.createdAt, tz) },
              {
                key: 'e',
                header: 'Event',
                render: (d) => `${d.eventType}${d.source !== 'event' ? ` (${d.source})` : ''}`,
              },
              {
                key: 's',
                header: 'Status',
                render: (d) => (
                  <Badge
                    tone={d.status === 'delivered' ? 'success' : d.status === 'dead' ? 'danger' : 'warning'}
                  >
                    {d.status}
                  </Badge>
                ),
              },
              { key: 'n', header: 'Attempts', render: (d) => d.attempts },
              {
                key: 'r',
                header: 'Last result',
                render: (d) => d.lastError ?? (d.lastStatusCode ? `HTTP ${d.lastStatusCode}` : '—'),
              },
              {
                key: 'a',
                header: 'Actions',
                render: (d) =>
                  (d.status === 'dead' || d.status === 'failed') && (
                    <Button size="sm" onClick={() => replay.mutate(d.id)}>
                      Replay
                    </Button>
                  ),
              },
            ]}
          />
        </Card>
      )}
      <Dialog
        open={form !== null}
        title="Add webhook endpoint"
        onClose={() => setForm(null)}
        footer={
          <>
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!form?.name.trim() || !form?.events.length}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              Add
            </Button>
          </>
        }
      >
        {form && (
          <>
            <TextField
              label="Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <TextField
              label="URL"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              hint="https only; internal or private addresses are refused"
            />
            <fieldset style={{ border: 0, padding: 0 }}>
              <legend className="uc-label">Events</legend>
              {WEBHOOK_EVENT_TYPES.map((t) => (
                <Checkbox
                  key={t}
                  label={t}
                  checked={form.events.includes(t)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      events: e.target.checked ? [...form.events, t] : form.events.filter((x) => x !== t),
                    })
                  }
                />
              ))}
            </fieldset>
            {create.error && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
          </>
        )}
      </Dialog>
    </>
  );
}
