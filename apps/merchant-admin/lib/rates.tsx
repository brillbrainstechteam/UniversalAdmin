'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ProposeRateRequest, type MetalRate, type PricingCatalogOptions } from '@uc/contracts';
import { Alert, Button, ConfirmDialog, Dialog, SelectField, TextField, errorMessage, useToast } from '@uc/ui';
import { useState } from 'react';
import { serverErrors, validate } from './forms';
import { RATE_UNIT_LABELS } from './pricing';
import { useTenant, useTenantQuery } from './tenant';

/** Approve / reject for a proposed rate. Hidden for the proposer (maker-checker) and without rates.approve. */
export function RateDecisionButtons({ rate }: { rate: MetalRate }) {
  const { api, can, tenantId, context } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const [rejecting, setRejecting] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['t', tenantId, 'rates'] });
  const approve = useMutation({
    mutationFn: () => api(`/v1/admin/rates/${rate.id}/approve`, { method: 'POST', body: {} }),
    onSuccess: () => {
      refresh();
      toast(`${rate.purity.label} rate approved`);
    },
  });
  const reject = useMutation({
    mutationFn: (reason: string) =>
      api(`/v1/admin/rates/${rate.id}/reject`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      refresh();
      setRejecting(false);
      toast('Rate rejected');
    },
  });
  if (rate.status !== 'proposed' || !can('rates.approve')) return null;
  if (rate.proposedBy?.id === context.user.id)
    return <span className="uc-muted">Needs another approver</span>;
  return (
    <span className="uc-row">
      <Button size="sm" variant="primary" loading={approve.isPending} onClick={() => approve.mutate()}>
        Approve<span className="uc-sr-only"> {rate.purity.label} rate</span>
      </Button>
      <Button size="sm" onClick={() => setRejecting(true)}>
        Reject<span className="uc-sr-only"> {rate.purity.label} rate</span>
      </Button>
      {approve.error && <span role="alert">{errorMessage(approve.error)}</span>}
      <ConfirmDialog
        open={rejecting}
        title={`Reject ${rate.purity.label} rate`}
        description="The proposal stays in the history as rejected."
        confirmLabel="Reject"
        tone="danger"
        requireReason
        loading={reject.isPending}
        error={reject.error ? errorMessage(reject.error) : null}
        onConfirm={(reason) => reject.mutate(reason)}
        onClose={() => setRejecting(false)}
      />
    </span>
  );
}

export function ProposeRateDialog({ onClose }: { onClose: () => void }) {
  const { api, tenantId } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const options = useTenantQuery<PricingCatalogOptions>(['pricing', 'options'], '/v1/admin/pricing/options');
  const [form, setForm] = useState({
    purityId: '',
    value: '',
    unit: 'per_g',
    sourceAsOf: '',
    effectiveFrom: '',
    reason: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) => api('/v1/admin/rates', { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'rates'] });
      toast('Rate proposed — it needs another person to approve it');
      onClose();
    },
    onError: (e) => {
      const r = serverErrors(e);
      setErrors(r.fields);
      setMessage(r.message);
    },
  });
  function submit() {
    const body = {
      purityId: form.purityId,
      value: form.value.trim(),
      unit: form.unit,
      reason: form.reason,
      ...(form.sourceAsOf ? { sourceAsOf: new Date(form.sourceAsOf).toISOString() } : {}),
      ...(form.effectiveFrom ? { effectiveFrom: new Date(form.effectiveFrom).toISOString() } : {}),
    };
    const check = validate(ProposeRateRequest, body);
    if (!check.ok) return setErrors(check.errors);
    setErrors({});
    save.mutate(body);
  }
  const purities = options.data?.purities ?? [];
  return (
    <Dialog
      open
      title="Propose a metal rate"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            Propose
          </Button>
        </>
      }
    >
      <div className="uc-form-grid">
        <SelectField
          label="Purity"
          value={form.purityId}
          error={errors.purityId}
          onChange={(e) => setForm({ ...form, purityId: e.target.value })}
          options={[
            { value: '', label: 'Choose…' },
            ...purities.map((p) => ({ value: p.id, label: `${p.metal} · ${p.label}` })),
          ]}
        />
        <TextField
          label={`Rate (${options.data?.currency ?? ''})`}
          inputMode="decimal"
          value={form.value}
          error={errors.value}
          onChange={(e) => setForm({ ...form, value: e.target.value })}
        />
        <SelectField
          label="Quoted unit"
          value={form.unit}
          onChange={(e) => setForm({ ...form, unit: e.target.value })}
          options={Object.entries(RATE_UNIT_LABELS).map(([value, label]) => ({ value, label }))}
          hint="Converted exactly to a rate per gram"
        />
        <TextField
          label="Source time (optional)"
          type="datetime-local"
          value={form.sourceAsOf}
          error={errors.sourceAsOf}
          onChange={(e) => setForm({ ...form, sourceAsOf: e.target.value })}
          hint="When the source quoted this value; defaults to now"
        />
        <TextField
          label="Effective from (optional)"
          type="datetime-local"
          value={form.effectiveFrom}
          error={errors.effectiveFrom}
          onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })}
          hint="Defaults to the moment it is approved"
        />
        <TextField
          label="Reason / source reference"
          value={form.reason}
          error={errors.reason}
          onChange={(e) => setForm({ ...form, reason: e.target.value })}
          hint="e.g. association board rate 10:30, phone confirmation"
        />
      </div>
      <Alert tone="info">
        A different person with approval rights must approve this rate before any quote uses it.
      </Alert>
      {message && <Alert tone="danger">{message}</Alert>}
    </Dialog>
  );
}
