'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  WEBHOOK_EVENT_TYPES,
  currencyMinorUnits,
  formatMinor,
  type Automation,
  type WebhookEndpoint,
} from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  ForbiddenState,
  PageHeader,
  SelectField,
  TextField,
  errorMessage,
  formatDateTime,
  useToast,
} from '@uc/ui';
import { useState } from 'react';
import { majorToMinor } from '../../../../lib/growth';
import { useTenant, useTenantQuery } from '../../../../lib/tenant';

interface Form {
  name: string;
  trigger: string;
  minTotal: string;
  action: 'notify_staff' | 'webhook';
  title: string;
  endpointId: string;
}

export default function AutomationsPage() {
  const { api, can, tenantId, context } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const currency = context.tenant.defaultCurrency;
  const mu = currencyMinorUnits(currency);
  const enabled = can('integrations.manage') && context.features.includes('automations');
  const list = useTenantQuery<{ items: Automation[] }>(
    ['automations'],
    '/v1/admin/automations',
    undefined,
    enabled,
  );
  const endpoints = useTenantQuery<{ items: WebhookEndpoint[] }>(
    ['webhooks'],
    '/v1/admin/webhooks',
    undefined,
    enabled && can('webhooks.manage'),
  );
  const [form, setForm] = useState<Form | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['t', tenantId, 'automations'] });
  const save = useMutation({
    mutationFn: () => {
      const min = majorToMinor(form!.minTotal, mu);
      if (min === 'invalid') throw new Error('Enter the minimum as an amount like 500.00');
      return api('/v1/admin/automations', {
        method: 'POST',
        body: {
          name: form!.name.trim(),
          trigger: form!.trigger,
          conditions: { minOrderTotalMinor: min, channelId: null },
          action:
            form!.action === 'webhook'
              ? { type: 'webhook', endpointId: form!.endpointId }
              : { type: 'notify_staff', title: form!.title.trim() },
        },
      });
    },
    onSuccess: () => {
      setForm(null);
      refresh();
      toast('Automation created');
    },
  });
  const toggle = useMutation({
    mutationFn: (a: Automation) =>
      api(`/v1/admin/automations/${a.id}`, {
        method: 'PUT',
        body: {
          name: a.name,
          trigger: a.trigger,
          conditions: a.conditions,
          action: a.action,
          status: a.status === 'active' ? 'paused' : 'active',
          version: a.version,
        },
      }),
    onSuccess: refresh,
  });
  if (!enabled) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="Automations"
        description="When an event happens, check simple conditions and notify staff or call a webhook. Actions never start other automations, so rules cannot loop."
        actions={
          <Button
            variant="primary"
            onClick={() =>
              setForm({
                name: '',
                trigger: 'OrderConfirmed',
                minTotal: '',
                action: 'notify_staff',
                title: '',
                endpointId: endpoints.data?.items[0]?.id ?? '',
              })
            }
          >
            New automation
          </Button>
        }
      />
      <Card>
        <DataTable
          caption="Automations"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          rowKey={(a) => a.id}
          empty={<EmptyState title="No automations yet" />}
          columns={[
            { key: 'n', header: 'Automation', render: (a) => a.name },
            {
              key: 't',
              header: 'When',
              render: (a) =>
                `${a.trigger}${a.conditions.minOrderTotalMinor ? ` and total ≥ ${currency} ${formatMinor(a.conditions.minOrderTotalMinor, mu)}` : ''}`,
            },
            {
              key: 'a',
              header: 'Then',
              render: (a) =>
                a.action.type === 'notify_staff'
                  ? `Notify staff: “${a.action.title}”`
                  : `Webhook to ${endpoints.data?.items.find((e) => e.id === (a.action as { endpointId: string }).endpointId)?.name ?? 'endpoint'}`,
            },
            {
              key: 'r',
              header: 'Runs',
              render: (a) => `${a.runs.done} done · ${a.runs.skipped} skipped · ${a.runs.failed} failed`,
            },
            {
              key: 'l',
              header: 'Last run',
              render: (a) => (a.lastRunAt ? formatDateTime(a.lastRunAt, context.tenant.timezone) : '—'),
            },
            {
              key: 's',
              header: 'Status',
              render: (a) => <Badge tone={a.status === 'active' ? 'success' : undefined}>{a.status}</Badge>,
            },
            {
              key: 'x',
              header: 'Actions',
              render: (a) => (
                <Button size="sm" onClick={() => toggle.mutate(a)}>
                  {a.status === 'active' ? 'Pause' : 'Resume'}
                </Button>
              ),
            },
          ]}
        />
      </Card>
      <Dialog
        open={form !== null}
        title="New automation"
        onClose={() => setForm(null)}
        footer={
          <>
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={
                !form?.name.trim() || (form.action === 'notify_staff' ? !form.title.trim() : !form.endpointId)
              }
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              Create
            </Button>
          </>
        }
      >
        {form && (
          <div className="uc-form-grid">
            <TextField
              label="Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <SelectField
              label="When this happens"
              value={form.trigger}
              onChange={(e) => setForm({ ...form, trigger: e.target.value })}
              options={WEBHOOK_EVENT_TYPES.map((t) => ({ value: t, label: t }))}
            />
            <TextField
              label={`Only if order total is at least (${currency}, optional)`}
              inputMode="decimal"
              value={form.minTotal}
              onChange={(e) => setForm({ ...form, minTotal: e.target.value })}
            />
            <SelectField
              label="Do this"
              value={form.action}
              onChange={(e) => setForm({ ...form, action: e.target.value as Form['action'] })}
              options={[
                { value: 'notify_staff', label: 'Notify staff in the inbox' },
                ...(endpoints.data?.items.length ? [{ value: 'webhook', label: 'Call a webhook' }] : []),
              ]}
            />
            {form.action === 'notify_staff' ? (
              <TextField
                label="Notification title"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            ) : (
              <SelectField
                label="Webhook endpoint"
                value={form.endpointId}
                onChange={(e) => setForm({ ...form, endpointId: e.target.value })}
                options={(endpoints.data?.items ?? []).map((ep) => ({ value: ep.id, label: ep.name }))}
              />
            )}
          </div>
        )}
        {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
      </Dialog>
    </>
  );
}
