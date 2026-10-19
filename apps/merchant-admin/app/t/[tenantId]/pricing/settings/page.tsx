'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CreateTaxRuleRequest, type PricingSettings, type TaxRule } from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  SelectField,
  TextField,
  errorMessage,
  formatDateTime,
  useToast,
} from '@uc/ui';
import { useEffect, useState } from 'react';
import { serverErrors, validate } from '../../../../../lib/forms';
import { PricingTabs } from '../../../../../lib/pricing';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

const GROUPS = ['metal', 'making', 'wastage', 'stones', 'charges', 'list_price'] as const;

function TaxDialog({ rule, onClose }: { rule: TaxRule | 'new'; onClose: () => void }) {
  const { api, tenantId } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const r = rule === 'new' ? null : rule;
  const [form, setForm] = useState({
    label: r?.label ?? '',
    ratePercent: r?.ratePercent.replace(/0+$/, '').replace(/\.$/, '') ?? '',
    appliesTo: r?.appliesTo ?? ['metal', 'making'],
    status: r?.status ?? 'pending_validation',
    validationNote: r?.validationNote ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) =>
      r
        ? api(`/v1/admin/pricing/tax-rules/${r.id}`, { method: 'PATCH', body })
        : api('/v1/admin/pricing/tax-rules', { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'pricing'] });
      toast('Tax rule saved');
      onClose();
    },
    onError: (e) => {
      const s = serverErrors(e);
      setErrors(s.fields);
      setMessage(s.message);
    },
  });
  function submit() {
    if (!r) {
      const body = { label: form.label, ratePercent: form.ratePercent.trim(), appliesTo: form.appliesTo };
      const check = validate(CreateTaxRuleRequest, body);
      if (!check.ok) return setErrors(check.errors);
      return save.mutate(body);
    }
    save.mutate({
      version: r.version,
      label: form.label,
      ratePercent: form.ratePercent.trim(),
      appliesTo: form.appliesTo,
      status: form.status,
      validationNote: form.validationNote.trim() || null,
    });
  }
  return (
    <Dialog
      open
      title={r ? `Edit ${r.label}` : 'New tax rule'}
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
        <TextField
          label="Label"
          value={form.label}
          error={errors.label}
          onChange={(e) => setForm({ ...form, label: e.target.value })}
        />
        <TextField
          label="Rate %"
          inputMode="decimal"
          value={form.ratePercent}
          error={errors.ratePercent}
          onChange={(e) => setForm({ ...form, ratePercent: e.target.value })}
        />
        {r && (
          <SelectField
            label="Status"
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value as TaxRule['status'] })}
            options={[
              { value: 'pending_validation', label: 'Pending validation' },
              { value: 'validated', label: 'Validated by accountant' },
              { value: 'inactive', label: 'Inactive (not applied)' },
            ]}
          />
        )}
        {r && (
          <TextField
            label="Validation note"
            value={form.validationNote}
            error={errors.validationNote}
            onChange={(e) => setForm({ ...form, validationNote: e.target.value })}
            hint="Who validated it, when, against what"
          />
        )}
      </div>
      <div className="uc-row" style={{ flexWrap: 'wrap' }} role="group" aria-label="Applies to">
        {GROUPS.map((g) => (
          <Checkbox
            key={g}
            label={`on ${g.replace('_', ' ')}`}
            checked={form.appliesTo.includes(g)}
            onChange={(e) =>
              setForm({
                ...form,
                appliesTo: e.target.checked ? [...form.appliesTo, g] : form.appliesTo.filter((x) => x !== g),
              })
            }
          />
        ))}
      </div>
      {errors.appliesTo && <Alert tone="danger">{errors.appliesTo}</Alert>}
      <Alert tone="warning">
        Tax rates, taxable components and place-of-supply rules must be confirmed by your accountant. Changing
        the rate or scope of a validated rule puts it back to pending validation.
      </Alert>
      {message && <Alert tone="danger">{message}</Alert>}
    </Dialog>
  );
}

export default function PricingSettingsPage() {
  const { api, can, tenantId, context } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const enabled = can('pricing.read') && context.features.includes('pricing');
  const settings = useTenantQuery<PricingSettings>(
    ['pricing', 'settings'],
    '/v1/admin/pricing/settings',
    undefined,
    enabled,
  );
  const taxes = useTenantQuery<{ items: TaxRule[] }>(
    ['pricing', 'tax-rules'],
    '/v1/admin/pricing/tax-rules',
    undefined,
    enabled,
  );
  const [form, setForm] = useState({
    quoteTtlMinutes: '',
    rateMaxAgeMinutes: '',
    stalePolicy: 'block',
    ruleReviewRequired: true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<TaxRule | 'new' | null>(null);
  useEffect(() => {
    if (settings.data)
      setForm({
        quoteTtlMinutes: String(settings.data.quoteTtlMinutes),
        rateMaxAgeMinutes: String(settings.data.rateMaxAgeMinutes),
        stalePolicy: settings.data.stalePolicy,
        ruleReviewRequired: settings.data.ruleReviewRequired,
      });
  }, [settings.data]);
  const int = (v: string) => (/^\d{1,6}$/.test(v) ? Number.parseInt(v, 10) : -1);
  const save = useMutation({
    mutationFn: () =>
      api<PricingSettings>('/v1/admin/pricing/settings', {
        method: 'PUT',
        body: {
          version: settings.data!.version,
          quoteTtlMinutes: int(form.quoteTtlMinutes),
          rateMaxAgeMinutes: int(form.rateMaxAgeMinutes),
          stalePolicy: form.stalePolicy,
          ruleReviewRequired: form.ruleReviewRequired,
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'pricing'] });
      setErrors({});
      toast('Pricing settings saved');
    },
    onError: (e) => setErrors(serverErrors(e).fields),
  });
  if (!enabled) return <ForbiddenState />;
  const edit = can('pricing.edit');
  return (
    <>
      <PageHeader
        title="Pricing settings & tax"
        description="Quote validity, rate freshness and review rules, and the tax rules prices may reference."
      />
      <PricingTabs />
      <Card
        title="Quotes and rates"
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
                label="Quote validity (minutes)"
                inputMode="numeric"
                value={form.quoteTtlMinutes}
                disabled={!edit}
                error={errors.quoteTtlMinutes}
                onChange={(e) => setForm({ ...form, quoteTtlMinutes: e.target.value })}
                hint="Prices are held this long, then recalculated at checkout"
              />
              <TextField
                label="Maximum rate age (minutes)"
                inputMode="numeric"
                value={form.rateMaxAgeMinutes}
                disabled={!edit}
                error={errors.rateMaxAgeMinutes}
                onChange={(e) => setForm({ ...form, rateMaxAgeMinutes: e.target.value })}
                hint="Measured from the source time of the approved rate"
              />
              <SelectField
                label="When a rate is stale"
                value={form.stalePolicy}
                disabled={!edit}
                onChange={(e) => setForm({ ...form, stalePolicy: e.target.value })}
                options={[
                  { value: 'block', label: 'Block pricing until a fresh rate is approved' },
                  { value: 'use_last_approved', label: 'Use the last approved rate, flagged as stale' },
                ]}
              />
            </div>
            <Checkbox
              label="Rule review: the person who saved a draft cannot publish it"
              checked={form.ruleReviewRequired}
              disabled={!edit}
              onChange={(e) => setForm({ ...form, ruleReviewRequired: e.target.checked })}
            />
            <span className="uc-muted">
              Metal rates always need a second approver. Last updated{' '}
              {formatDateTime(settings.data.updatedAt, context.tenant.timezone)}.
            </span>
            {save.error && Object.keys(errors).length === 0 && (
              <Alert tone="danger">{errorMessage(save.error)}</Alert>
            )}
          </>
        )}
      </Card>
      <Card
        title="Tax rules"
        actions={
          edit && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              New tax rule
            </Button>
          )
        }
      >
        <Alert tone="info">
          No tax rates are pre-filled. Enter the rules your accountant gives you; quotes show them as pending
          until validated.
        </Alert>
        <DataTable
          caption="Tax rules"
          rows={taxes.data?.items}
          isLoading={taxes.isLoading}
          error={taxes.error}
          rowKey={(t) => t.id}
          empty={<EmptyState title="No tax rules" />}
          columns={[
            { key: 'label', header: 'Label', render: (t) => t.label },
            {
              key: 'rate',
              header: 'Rate',
              render: (t) => (
                <span className="uc-mono">{t.ratePercent.replace(/0+$/, '').replace(/\.$/, '')}%</span>
              ),
            },
            { key: 'applies', header: 'Applies to', render: (t) => t.appliesTo.join(', ') },
            {
              key: 'status',
              header: 'Status',
              render: (t) => (
                <Badge
                  tone={
                    t.status === 'validated' ? 'success' : t.status === 'inactive' ? undefined : 'warning'
                  }
                >
                  {t.status.replace('_', ' ')}
                </Badge>
              ),
            },
            { key: 'note', header: 'Validation note', render: (t) => t.validationNote ?? '—' },
            {
              key: 'act',
              header: 'Actions',
              render: (t) =>
                edit ? (
                  <Button size="sm" onClick={() => setEditing(t)}>
                    Edit<span className="uc-sr-only"> {t.label}</span>
                  </Button>
                ) : null,
            },
          ]}
        />
      </Card>
      {editing && <TaxDialog rule={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
