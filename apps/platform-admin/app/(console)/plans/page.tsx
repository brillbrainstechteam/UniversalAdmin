'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PLAN_LIMIT_KEYS, PLAN_LIMIT_LABELS, type Plan, type PlanLimitKey } from '@uc/contracts';
import {
  Alert,
  apiRequest,
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
} from '@uc/ui';
import { useState } from 'react';
import { usePlatformMe, usePlatformQuery } from '../../../lib/platform';

type Form = {
  key: string;
  isNew: boolean;
  version?: number;
  name: string;
  description: string;
  status: 'active' | 'retired';
  limits: Record<PlanLimitKey, string>;
};

const toForm = (p: Plan): Form => ({
  key: p.key,
  isNew: false,
  version: p.version,
  name: p.name,
  description: p.description,
  status: p.status,
  limits: Object.fromEntries(
    PLAN_LIMIT_KEYS.map((k) => [k, p.limits[k] === null ? '' : String(p.limits[k])]),
  ) as Form['limits'],
});

export default function PlansPage() {
  const me = usePlatformMe();
  const qc = useQueryClient();
  const canRead = me.can('platform.tenants.read');
  const canEdit = me.can('platform.plans.manage');
  const plans = usePlatformQuery<{ items: Plan[] }>(['plans'], '/v1/platform/plans', undefined, canRead);
  const [form, setForm] = useState<Form | null>(null);
  const save = useMutation({
    mutationFn: (f: Form) =>
      apiRequest<Plan>(`/v1/platform/plans/${f.key}`, {
        method: 'PUT',
        body: {
          name: f.name.trim(),
          description: f.description.trim(),
          status: f.status,
          version: f.isNew ? undefined : f.version,
          limits: Object.fromEntries(
            PLAN_LIMIT_KEYS.map((k) => [
              k,
              f.limits[k].trim() === '' ? null : Number.parseInt(f.limits[k], 10),
            ]),
          ),
        },
      }),
    onSuccess: () => {
      setForm(null);
      void qc.invalidateQueries({ queryKey: ['p', 'plans'] });
    },
  });
  if (me.data && !canRead) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="Plans"
        description="Usage limits per plan. Products, staff seats, locations and domains are hard limits; orders per month is a warning only. No billing is connected, so plans carry no price."
        actions={
          canEdit && (
            <Button
              variant="primary"
              onClick={() =>
                setForm({
                  key: '',
                  isNew: true,
                  name: '',
                  description: '',
                  status: 'active',
                  limits: { products: '', staffSeats: '', locations: '', domains: '', ordersPerMonth: '' },
                })
              }
            >
              New plan
            </Button>
          )
        }
      />
      <Card>
        <DataTable
          caption="Plans"
          rows={plans.data?.items}
          isLoading={plans.isLoading}
          error={plans.error}
          rowKey={(p) => p.key}
          empty={<EmptyState title="No plans" />}
          columns={[
            {
              key: 'n',
              header: 'Plan',
              render: (p) => (
                <>
                  <strong>{p.name}</strong> <span className="uc-mono uc-muted">{p.key}</span>
                  <div className="uc-muted">{p.description}</div>
                </>
              ),
            },
            ...PLAN_LIMIT_KEYS.map((k) => ({
              key: k,
              header: PLAN_LIMIT_LABELS[k].split(' (')[0]!,
              render: (p: Plan) => p.limits[k] ?? '∞',
            })),
            { key: 't', header: 'Tenants', render: (p) => p.tenantCount },
            {
              key: 's',
              header: 'Status',
              render: (p) => <Badge tone={p.status === 'active' ? 'success' : undefined}>{p.status}</Badge>,
            },
            {
              key: 'a',
              header: 'Actions',
              render: (p) =>
                canEdit && (
                  <Button size="sm" onClick={() => setForm(toForm(p))}>
                    Edit
                  </Button>
                ),
            },
          ]}
        />
      </Card>
      <Dialog
        open={form !== null}
        title={form?.isNew ? 'New plan' : `Edit ${form?.name ?? 'plan'}`}
        onClose={() => setForm(null)}
        footer={
          <>
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!form?.name.trim() || !/^[a-z][a-z0-9_]{1,39}$/.test(form?.key ?? '')}
              loading={save.isPending}
              onClick={() => form && save.mutate(form)}
            >
              Save
            </Button>
          </>
        }
      >
        {form && (
          <>
            {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
            <TextField
              label="Key"
              value={form.key}
              disabled={!form.isNew}
              hint="Lower-case letters, digits and underscores; cannot be changed later."
              onChange={(e) => setForm({ ...form, key: e.target.value })}
            />
            <TextField
              label="Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <TextField
              label="Description"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
            {PLAN_LIMIT_KEYS.map((k) => (
              <TextField
                key={k}
                label={PLAN_LIMIT_LABELS[k]}
                inputMode="numeric"
                hint="Leave empty for unlimited."
                value={form.limits[k]}
                onChange={(e) => setForm({ ...form, limits: { ...form.limits, [k]: e.target.value } })}
              />
            ))}
            <SelectField
              label="Status"
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value as Form['status'] })}
              options={[
                { value: 'active', label: 'Active (can be assigned)' },
                { value: 'retired', label: 'Retired (kept for existing tenants)' },
              ]}
            />
          </>
        )}
      </Dialog>
    </>
  );
}
