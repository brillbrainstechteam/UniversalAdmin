'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PurityDefinition, SerialItem } from '@uc/contracts';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
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
  useUnsavedChangesWarning,
} from '@uc/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ComponentsEditor, toInputs, toRows, type ComponentRow } from '../../../../../lib/components-editor';
import { serverErrors } from '../../../../../lib/forms';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';
import {
  Checks,
  WeightField,
  fromRaw,
  grams,
  toInput,
  weightError,
  type WeightState,
} from '../../../../../lib/weight';

function formOf(item: SerialItem) {
  const raw = item.raw as Record<string, unknown>;
  return {
    serialTag: item.serialTag,
    huid: item.huid ?? '',
    purityId: item.purity.id,
    gross: fromRaw(raw.gross, item.grossG),
    net: fromRaw(raw.net, item.netG),
    stone: fromRaw(raw.stone, item.stoneG),
    enterFine: item.fineSource === 'entered',
    fine: fromRaw(raw.fine, item.fineG),
    pieces: String(item.pieces),
    certificates: item.certificates.map((c) => `${c.lab}: ${c.number}`).join('\n'),
    weightExceptionReason: item.weightExceptionReason ?? '',
    components: toRows(item.components),
  };
}

function RawVsCanonical({ item }: { item: SerialItem }) {
  const raw = item.raw as Record<string, { value?: string; unit?: string } | null | string>;
  const show = (k: string) => {
    const r = raw[k] as { value?: string; unit?: string } | null;
    return r?.value ? `${r.value} ${r.unit}` : '—';
  };
  return (
    <div className="uc-table-wrap">
      <table className="uc-table">
        <caption className="uc-sr-only">Measurements</caption>
        <thead>
          <tr>
            <th scope="col">Measure</th>
            <th scope="col">Canonical (grams)</th>
            <th scope="col">As entered</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Gross</td>
            <td className="uc-mono">{item.grossG}</td>
            <td>{show('gross')}</td>
          </tr>
          <tr>
            <td>Net (metal)</td>
            <td className="uc-mono">{item.netG}</td>
            <td>{show('net')}</td>
          </tr>
          <tr>
            <td>Stone</td>
            <td className="uc-mono">{item.stoneG}</td>
            <td>{show('stone')}</td>
          </tr>
          <tr>
            <td>Fine</td>
            <td className="uc-mono">{item.fineG}</td>
            <td>
              {item.fineSource === 'entered' ? (
                show('fine')
              ) : (
                <>
                  computed:{' '}
                  <span className="uc-mono">
                    {String((item.fineFormula as { id?: string } | null)?.id ?? '')}
                  </span>
                  , {item.purity.label} × net, rounded to{' '}
                  {String((item.fineFormula as { scale?: number } | null)?.scale ?? '')} dp
                </>
              )}
            </td>
          </tr>
          <tr>
            <td>Pieces</td>
            <td>{item.pieces}</td>
            <td>—</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export default function SerialItemPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const { can, api, tenantId, context } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const enabled = can('catalog.read') && context.features.includes('serialized_items');
  const item = useTenantQuery<SerialItem>(
    ['serial-items', itemId],
    `/v1/admin/serial-items/${itemId}`,
    undefined,
    enabled,
  );
  const purities = useTenantQuery<{ items: PurityDefinition[] }>(
    ['purities'],
    '/v1/admin/jewellery/purities',
    undefined,
    enabled,
  );
  const [form, setForm] = useState<ReturnType<typeof formOf> | null>(null);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [retiring, setRetiring] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => {
    if (item.data) setForm(formOf(item.data));
  }, [item.data]);
  const original = useMemo(() => (item.data ? formOf(item.data) : null), [item.data]);
  const dirty = !!form && JSON.stringify(form) !== JSON.stringify(original);
  useUnsavedChangesWarning(dirty);
  const setData = (i: SerialItem) => {
    qc.setQueryData(['t', tenantId, 'serial-items', itemId, {}], i);
    void qc.invalidateQueries({ queryKey: ['t', tenantId, 'serial-items'], refetchType: 'none' });
    setReason('');
    setErrors({});
    setMessage(null);
  };
  const onError = (e: unknown) => {
    const r = serverErrors(e);
    setErrors(r.fields);
    setMessage(r.message ?? (Object.keys(r.fields).length ? 'Fix the highlighted fields.' : null));
  };
  const save = useMutation({
    mutationFn: () => {
      const f = form!;
      const o = original!;
      const changed = <K extends keyof typeof f>(k: K) => JSON.stringify(f[k]) !== JSON.stringify(o[k]);
      const certificates = f.certificates
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [lab = '', ...rest] = l.split(':');
          return { lab: lab.trim(), number: rest.join(':').trim() };
        });
      return api<SerialItem>(`/v1/admin/serial-items/${itemId}`, {
        method: 'PATCH',
        body: {
          version: item.data!.version,
          ...(changed('serialTag') ? { serialTag: f.serialTag } : {}),
          ...(changed('huid') ? { huid: f.huid || null } : {}),
          ...(changed('purityId') ? { purityId: f.purityId } : {}),
          ...(changed('gross') ? { gross: toInput(f.gross) } : {}),
          ...(changed('net') ? { net: toInput(f.net) } : {}),
          ...(changed('stone') ? { stone: toInput(f.stone) ?? { value: '0', unit: 'g' } } : {}),
          ...(changed('enterFine') || changed('fine') ? { fine: f.enterFine ? toInput(f.fine) : null } : {}),
          ...(changed('pieces')
            ? { pieces: /^\d+$/.test(f.pieces) ? Number.parseInt(f.pieces, 10) : 0 }
            : {}),
          ...(changed('certificates') ? { certificates } : {}),
          ...(changed('components') ? { components: toInputs(f.components) } : {}),
          ...(changed('weightExceptionReason')
            ? { weightExceptionReason: f.weightExceptionReason || null }
            : {}),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
      });
    },
    onSuccess: (i) => {
      setData(i);
      toast('Item saved');
    },
    onError,
  });
  const retire = useMutation({
    mutationFn: () =>
      api<SerialItem>(`/v1/admin/serial-items/${itemId}`, {
        method: 'PATCH',
        body: { version: item.data!.version, status: 'retired' },
      }),
    onSuccess: (i) => {
      setData(i);
      setRetiring(false);
      toast('Item retired');
    },
  });
  const review = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      api<SerialItem>(`/v1/admin/serial-items/${itemId}/review`, {
        method: 'POST',
        body: { version: item.data!.version, decision, note },
      }),
    onSuccess: (i) => {
      setData(i);
      setNote('');
      toast(i.status === 'active' ? 'Exception approved' : 'Item rejected and retired');
    },
  });

  if (!enabled) return <ForbiddenState />;
  if (item.error) return <ErrorState error={item.error} onRetry={() => void item.refetch()} />;
  if (!item.data || !form) return <LoadingState />;
  const i = item.data;
  const readOnly = !can('jewellery.edit') || i.status === 'retired';
  const w = (k: 'gross' | 'net' | 'stone' | 'fine') => (v: WeightState) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));
  const huidLocked = i.huid !== null && !can('jewellery.review');

  return (
    <>
      <PageHeader
        title={`Piece ${i.serialTag}`}
        description={
          <>
            <Link href={`/t/${tenantId}/serial-items`}>Serialized items</Link> ·{' '}
            <Link href={`/t/${tenantId}/products/${i.productId}`}>{i.productTitle}</Link> ·{' '}
            <span className="uc-mono">{i.sku}</span>
            {context.features.includes('inventory') && can('inventory.read') && (
              <>
                {' '}
                · <Link href={`/t/${tenantId}/inventory/variants/${i.variantId}`}>Stock</Link>
              </>
            )}
          </>
        }
        actions={
          <>
            <StatusBadge status={i.status} />
            <StatusBadge status={i.stockState} />
            {i.location && <span className="uc-muted">{i.location.name}</span>}
            {!readOnly && (
              <Button variant="danger" onClick={() => setRetiring(true)}>
                Retire
              </Button>
            )}
          </>
        }
      />
      {i.status === 'retired' && <Alert tone="warning">Retired pieces are read-only.</Alert>}
      {i.status === 'pending_review' && (
        <Card title="Weight exception — review required">
          <p style={{ margin: 0 }}>
            Net weight exceeds gross weight. Reason given: <strong>{i.weightExceptionReason}</strong>
          </p>
          {can('jewellery.review') ? (
            <>
              <span className="uc-muted">
                A different person from the one who entered or last changed the measurements must review.
              </span>
              <TextField
                label="Review note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                hint="At least 5 characters; recorded in the audit log"
              />
              <div className="uc-row">
                <Button
                  variant="primary"
                  disabled={note.trim().length < 5}
                  loading={review.isPending && review.variables === 'approve'}
                  onClick={() => review.mutate('approve')}
                >
                  Approve
                </Button>
                <Button
                  variant="danger"
                  disabled={note.trim().length < 5}
                  loading={review.isPending && review.variables === 'reject'}
                  onClick={() => review.mutate('reject')}
                >
                  Reject and retire
                </Button>
              </div>
              {review.error && <Alert tone="danger">{errorMessage(review.error)}</Alert>}
            </>
          ) : (
            <span className="uc-muted">
              Waiting for a reviewer with the “Review weight exceptions” permission.
            </span>
          )}
        </Card>
      )}
      {i.review && (
        <Alert tone="info">
          Reviewed by {i.review.by ?? 'a former user'} on {formatDateTime(i.review.at)}: {i.review.note}
        </Alert>
      )}
      <Card title="Measurements">
        <RawVsCanonical item={i} />
        <Checks checks={i.checks} />
      </Card>
      <Card
        title="Edit piece"
        actions={
          !readOnly && (
            <Button
              variant="primary"
              disabled={!dirty}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              Save
            </Button>
          )
        }
      >
        {i.status === 'active' && !readOnly && (
          <Alert tone="info">
            This piece is active: changing measurements or the HUID requires a reason and is recorded in the
            audit log.
          </Alert>
        )}
        {message && <Alert tone="danger">{message}</Alert>}
        <div className="uc-form-grid">
          <TextField
            label="Serial tag"
            value={form.serialTag}
            disabled={readOnly}
            error={errors.serialTag}
            onChange={(e) => setForm({ ...form, serialTag: e.target.value })}
          />
          <TextField
            label="HUID"
            value={form.huid}
            disabled={readOnly || huidLocked}
            error={errors.huid}
            onChange={(e) => setForm({ ...form, huid: e.target.value.toUpperCase() })}
            hint={
              huidLocked
                ? 'Correcting an assigned HUID needs the review permission'
                : 'Optional; unique per merchant'
            }
          />
          <SelectField
            label="Purity"
            value={form.purityId}
            disabled={readOnly}
            error={errors.purityId}
            onChange={(e) => setForm({ ...form, purityId: e.target.value })}
            options={(purities.data?.items ?? [])
              .filter((p) => p.status === 'active' || p.id === form.purityId)
              .map((p) => ({ value: p.id, label: `${p.metal} ${p.label}` }))}
          />
          <TextField
            label="Pieces"
            inputMode="numeric"
            value={form.pieces}
            disabled={readOnly}
            error={errors.pieces}
            onChange={(e) => setForm({ ...form, pieces: e.target.value })}
          />
          <WeightField
            label="Gross weight"
            value={form.gross}
            disabled={readOnly}
            error={weightError(errors, 'gross')}
            onChange={w('gross')}
          />
          <WeightField
            label="Net weight"
            value={form.net}
            disabled={readOnly}
            error={weightError(errors, 'net')}
            onChange={w('net')}
          />
          <WeightField
            label="Stone weight"
            value={form.stone}
            disabled={readOnly}
            allowCarat
            error={weightError(errors, 'stone')}
            onChange={w('stone')}
          />
        </div>
        <Checkbox
          label="Fine weight entered manually"
          checked={form.enterFine}
          disabled={readOnly}
          onChange={(e) => setForm({ ...form, enterFine: e.target.checked })}
          description="Otherwise computed from net × fineness"
        />
        {form.enterFine && (
          <WeightField
            label="Fine weight"
            value={form.fine}
            disabled={readOnly}
            error={weightError(errors, 'fine')}
            onChange={w('fine')}
          />
        )}
        <TextField
          label="Weight exception reason (only if net exceeds gross)"
          value={form.weightExceptionReason}
          disabled={readOnly}
          error={errors.weightExceptionReason}
          onChange={(e) => setForm({ ...form, weightExceptionReason: e.target.value })}
        />
        <div className="uc-field">
          <label htmlFor="certs">Certificates (one per line: Lab: number)</label>
          <textarea
            id="certs"
            className="uc-textarea"
            rows={2}
            value={form.certificates}
            disabled={readOnly}
            onChange={(e) => setForm({ ...form, certificates: e.target.value })}
            placeholder="IGI: 123456789"
          />
          {Object.entries(errors)
            .filter(([k]) => k.startsWith('certificates'))
            .map(([k, v]) => (
              <span key={k} className="uc-error">
                {v}
              </span>
            ))}
        </div>
        <ComponentsEditor
          rows={form.components}
          onChange={(c: ComponentRow[]) => setForm({ ...form, components: c })}
          purities={purities.data?.items ?? []}
          errors={errors}
          prefix="components"
          disabled={readOnly}
        />
        {!readOnly && i.status === 'active' && (
          <TextField
            label="Reason for this change"
            value={reason}
            error={errors.reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
        <span className="uc-muted">
          Created {formatDateTime(i.createdAt)} · updated {formatDateTime(i.updatedAt)} · version {i.version}
        </span>
      </Card>
      {i.components.length > 0 && (
        <Card title="Components">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {i.components.map((c) => (
              <li key={c.id}>
                {c.count} × {c.kind}
                {c.description ? ` (${c.description})` : ''}: {grams(c.weightG)}
                {c.caratWeight ? ` = ${c.caratWeight.replace(/0+$/, '').replace(/\.$/, '')} ct` : ''}
                {c.purity ? ` · ${c.purity.label}` : ''}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <ConfirmDialog
        open={retiring}
        title="Retire this piece?"
        description="Retired pieces become read-only and cannot be sold. This is recorded in the audit log."
        confirmLabel="Retire"
        loading={retire.isPending}
        error={retire.error ? errorMessage(retire.error) : null}
        onConfirm={() => retire.mutate()}
        onClose={() => setRetiring(false)}
      />
    </>
  );
}
