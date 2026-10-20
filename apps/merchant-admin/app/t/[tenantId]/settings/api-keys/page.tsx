'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { API_KEY_SCOPES, type ApiKey } from '@uc/contracts';
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
} from '@uc/ui';
import { useState } from 'react';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

export default function ApiKeysPage() {
  const { api, can, tenantId, context } = useTenant();
  const qc = useQueryClient();
  const tz = context.tenant.timezone;
  const enabled = can('apikeys.manage');
  const list = useTenantQuery<{ items: ApiKey[] }>(['api-keys'], '/v1/admin/api-keys', undefined, enabled);
  const [form, setForm] = useState<{ name: string; scopes: string[]; days: string } | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['t', tenantId, 'api-keys'] });
  const create = useMutation({
    mutationFn: () =>
      api<{ key: string }>('/v1/admin/api-keys', {
        method: 'POST',
        body: {
          name: form!.name.trim(),
          scopes: form!.scopes,
          expiresInDays: form!.days ? Number.parseInt(form!.days, 10) : null,
        },
      }),
    onSuccess: (r) => {
      setForm(null);
      setShown(r.key);
      refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/v1/admin/api-keys/${id}/revoke`, { method: 'POST' }),
    onSuccess: refresh,
  });
  if (!enabled) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="API keys"
        description="Read-only keys for your own systems. A key acts for the person who created it and never has more access than they do."
        actions={
          <Button
            variant="primary"
            onClick={() => setForm({ name: '', scopes: ['orders.read'], days: '90' })}
          >
            Create key
          </Button>
        }
      />
      {shown && (
        <Alert tone="warning" title="Copy this key now — it is not shown again">
          <code className="uc-mono">{shown}</code>
          <p className="uc-muted">
            Send it as <code>Authorization: Bearer &lt;key&gt;</code> on GET requests to the admin API.
          </p>
        </Alert>
      )}
      <Card>
        <DataTable
          caption="API keys"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          rowKey={(k) => k.id}
          empty={<EmptyState title="No API keys" />}
          columns={[
            {
              key: 'n',
              header: 'Key',
              render: (k) => (
                <>
                  <strong>{k.name}</strong>
                  <div className="uc-mono uc-muted">{k.prefix}…</div>
                </>
              ),
            },
            { key: 's', header: 'Scopes', render: (k) => k.scopes.join(', ') },
            { key: 'b', header: 'Created by', render: (k) => k.createdBy.name },
            {
              key: 'u',
              header: 'Last used',
              render: (k) => (k.lastUsedAt ? formatDateTime(k.lastUsedAt, tz) : 'never'),
            },
            {
              key: 'e',
              header: 'Expires',
              render: (k) => (k.expiresAt ? formatDateTime(k.expiresAt, tz) : 'never'),
            },
            {
              key: 'st',
              header: 'Status',
              render: (k) => (k.revokedAt ? <Badge>revoked</Badge> : <Badge tone="success">active</Badge>),
            },
            {
              key: 'a',
              header: 'Actions',
              render: (k) =>
                !k.revokedAt && (
                  <Button size="sm" variant="danger" onClick={() => revoke.mutate(k.id)}>
                    Revoke
                  </Button>
                ),
            },
          ]}
        />
      </Card>
      <Dialog
        open={form !== null}
        title="Create API key"
        onClose={() => setForm(null)}
        footer={
          <>
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!form?.name.trim() || !form?.scopes.length}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              Create
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
            <fieldset style={{ border: 0, padding: 0 }}>
              <legend className="uc-label">Read access</legend>
              {API_KEY_SCOPES.map((s) => (
                <Checkbox
                  key={s}
                  label={s}
                  disabled={!can(s)}
                  description={can(s) ? undefined : 'you do not have this permission'}
                  checked={form.scopes.includes(s)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      scopes: e.target.checked ? [...form.scopes, s] : form.scopes.filter((x) => x !== s),
                    })
                  }
                />
              ))}
            </fieldset>
            <TextField
              label="Expires after (days, empty = never)"
              inputMode="numeric"
              value={form.days}
              onChange={(e) => setForm({ ...form, days: e.target.value.replace(/\D/g, '') })}
            />
            {create.error && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
          </>
        )}
      </Dialog>
    </>
  );
}
