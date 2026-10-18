'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CreatePurityRequest, type JewellerySettings, type PurityDefinition } from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  SelectField,
  StatusBadge,
  TextField,
  errorMessage,
  formatDateTime,
  useToast,
} from '@uc/ui';
import { useEffect, useState } from 'react';
import { serverErrors, validate } from '../../../../../lib/forms';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

function PurityDialog({ purity, onClose }: { purity: PurityDefinition | 'new'; onClose: () => void }) {
  const { api, tenantId } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const isNew = purity === 'new';
  const p = isNew ? null : purity;
  const [form, setForm] = useState({
    metal: p?.metal ?? 'gold',
    code: p?.code ?? '',
    label: p?.label ?? '',
    fineness: p?.fineness.replace(/0+$/, '').replace(/\.$/, '') ?? '',
    status: p?.status ?? 'active',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) =>
      isNew
        ? api('/v1/admin/jewellery/purities', { method: 'POST', body })
        : api(`/v1/admin/jewellery/purities/${p!.id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'purities'] });
      toast('Purity saved');
      onClose();
    },
    onError: (e) => {
      const r = serverErrors(e);
      setErrors(r.fields);
      setMessage(r.message);
    },
  });
  function submit() {
    if (isNew) {
      const body = { metal: form.metal, code: form.code, label: form.label, fineness: form.fineness };
      const check = validate(CreatePurityRequest, body);
      if (!check.ok) return setErrors(check.errors);
      save.mutate(body);
    } else {
      save.mutate({ version: p!.version, label: form.label, fineness: form.fineness, status: form.status });
    }
  }
  return (
    <Dialog
      open
      title={isNew ? 'New purity' : `Edit ${p!.label}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="uc-form-grid">
        <SelectField
          label="Metal"
          value={form.metal}
          disabled={!isNew}
          onChange={(e) => setForm({ ...form, metal: e.target.value as typeof form.metal })}
          options={['gold', 'silver', 'platinum', 'palladium', 'other'].map((m) => ({ value: m, label: m }))}
        />
        <TextField
          label="Code"
          value={form.code}
          disabled={!isNew}
          error={errors.code}
          onChange={(e) => setForm({ ...form, code: e.target.value })}
          hint="e.g. 22K, 925"
        />
        <TextField
          label="Label"
          value={form.label}
          error={errors.label}
          onChange={(e) => setForm({ ...form, label: e.target.value })}
        />
        <TextField
          label="Fineness (fraction of pure metal)"
          inputMode="decimal"
          value={form.fineness}
          error={errors.fineness}
          onChange={(e) => setForm({ ...form, fineness: e.target.value })}
          hint="e.g. 0.916 for 22K. Saving confirms the value."
        />
        {!isNew && (
          <SelectField
            label="Status"
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value as 'active' | 'inactive' })}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Inactive (not selectable)' },
            ]}
          />
        )}
      </div>
      <Alert tone="info">
        Changing a fineness only affects future computations. Existing pieces keep the fine weight and formula
        inputs recorded when they were measured.
      </Alert>
      {message && <Alert tone="danger">{message}</Alert>}
    </Dialog>
  );
}

export default function JewellerySettingsPage() {
  const { can, api, tenantId, context } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const enabled = can('catalog.read') && context.features.includes('jewellery');
  const settings = useTenantQuery<JewellerySettings>(
    ['jewellery-settings'],
    '/v1/admin/jewellery/settings',
    undefined,
    enabled,
  );
  const purities = useTenantQuery<{ items: PurityDefinition[] }>(
    ['purities'],
    '/v1/admin/jewellery/purities',
    undefined,
    enabled,
  );
  const [form, setForm] = useState({ weightToleranceG: '', fineScale: '3', huidFormat: 'bis_6_alnum' });
  const [editing, setEditing] = useState<PurityDefinition | 'new' | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (settings.data)
      setForm({
        weightToleranceG: settings.data.weightToleranceG.replace(/0+$/, '').replace(/\.$/, ''),
        fineScale: String(settings.data.fineScale),
        huidFormat: settings.data.huidFormat,
      });
  }, [settings.data]);
  const save = useMutation({
    mutationFn: () =>
      api<JewellerySettings>('/v1/admin/jewellery/settings', {
        method: 'PUT',
        body: {
          version: settings.data!.version,
          weightToleranceG: form.weightToleranceG,
          fineScale: Number.parseInt(form.fineScale, 10),
          huidFormat: form.huidFormat,
        },
      }),
    onSuccess: (s) => {
      qc.setQueryData(['t', tenantId, 'jewellery-settings', {}], s);
      setErrors({});
      toast('Jewellery settings saved');
    },
    onError: (e) => setErrors(serverErrors(e).fields),
  });
  const confirm = useMutation({
    mutationFn: (p: PurityDefinition) =>
      api(`/v1/admin/jewellery/purities/${p.id}`, {
        method: 'PATCH',
        body: { version: p.version, confirm: true },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'purities'] });
      toast('Purity confirmed');
    },
  });

  if (!enabled) return <ForbiddenState />;
  const edit = can('jewellery.edit');
  return (
    <>
      <PageHeader
        title="Jewellery"
        description="Measurement rules and metal purities. Values here are merchant configuration pending your own assay/regulatory validation."
      />
      <Card
        title="Measurement rules"
        actions={
          edit &&
          settings.data && (
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          )
        }
      >
        {settings.error ? (
          <ErrorState error={settings.error} />
        ) : !settings.data ? (
          <LoadingState rows={2} />
        ) : (
          <>
            <div className="uc-form-grid">
              <TextField
                label="Weight tolerance (g)"
                inputMode="decimal"
                value={form.weightToleranceG}
                disabled={!edit}
                error={errors.weightToleranceG}
                onChange={(e) => setForm({ ...form, weightToleranceG: e.target.value })}
                hint="Differences within this are not flagged"
              />
              <SelectField
                label="Fine weight rounding"
                value={form.fineScale}
                disabled={!edit}
                onChange={(e) => setForm({ ...form, fineScale: e.target.value })}
                options={[0, 1, 2, 3, 4, 5, 6].map((n) => ({
                  value: String(n),
                  label: `${n} decimal places (half-up)`,
                }))}
              />
              <SelectField
                label="HUID format"
                value={form.huidFormat}
                disabled={!edit}
                onChange={(e) => setForm({ ...form, huidFormat: e.target.value })}
                options={[
                  { value: 'bis_6_alnum', label: '6 letters/digits (BIS HUID style)' },
                  { value: 'free_text', label: 'Free text' },
                ]}
                hint="Applicability of hallmarking rules must be validated for your business"
              />
            </div>
            <span className="uc-muted">Last updated {formatDateTime(settings.data.updatedAt)}</span>
            {save.error && Object.keys(errors).length === 0 && (
              <Alert tone="danger">{errorMessage(save.error)}</Alert>
            )}
          </>
        )}
      </Card>
      <Card
        title="Purities"
        actions={
          edit && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              New purity
            </Button>
          )
        }
      >
        {purities.data?.items.some((p) => p.source === 'platform_default' && !p.confirmedAt) && (
          <Alert tone="warning">
            Some purities are platform defaults. Confirm each fineness before relying on computed fine
            weights.
          </Alert>
        )}
        <DataTable
          caption="Purities"
          rows={purities.data?.items}
          isLoading={purities.isLoading}
          error={purities.error}
          rowKey={(p) => p.id}
          empty={<EmptyState title="No purities" />}
          columns={[
            { key: 'metal', header: 'Metal', render: (p) => p.metal },
            {
              key: 'label',
              header: 'Purity',
              render: (p) => (
                <>
                  {p.label} <span className="uc-mono uc-muted">{p.code}</span>
                </>
              ),
            },
            {
              key: 'fineness',
              header: 'Fineness',
              render: (p) => <span className="uc-mono">{p.fineness}</span>,
            },
            {
              key: 'source',
              header: 'Source',
              render: (p) =>
                p.source === 'merchant' || p.confirmedAt ? (
                  <Badge tone="success">Confirmed</Badge>
                ) : (
                  <Badge tone="warning">Default — unconfirmed</Badge>
                ),
            },
            { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
            {
              key: 'actions',
              header: 'Actions',
              render: (p) =>
                edit ? (
                  <span className="uc-row">
                    {p.source === 'platform_default' && !p.confirmedAt && (
                      <Button
                        size="sm"
                        variant="primary"
                        loading={confirm.isPending}
                        onClick={() => confirm.mutate(p)}
                      >
                        Confirm<span className="uc-sr-only"> {p.label}</span>
                      </Button>
                    )}
                    <Button size="sm" onClick={() => setEditing(p)}>
                      Edit<span className="uc-sr-only"> {p.label}</span>
                    </Button>
                  </span>
                ) : null,
            },
          ]}
        />
      </Card>
      {editing && <PurityDialog purity={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
