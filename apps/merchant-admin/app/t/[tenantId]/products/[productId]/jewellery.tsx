'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  BulkSerialItemsResponse,
  JewellerySpec,
  Product,
  PurityDefinition,
  Variant,
} from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  SelectField,
  StatusBadge,
  TextField,
  errorMessage,
  useToast,
} from '@uc/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ComponentsEditor, toInputs, toRows, type ComponentRow } from '../../../../../lib/components-editor';
import { serverErrors } from '../../../../../lib/forms';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';
import {
  Checks,
  WeightField,
  emptyWeight,
  fromRaw,
  grams,
  toInput,
  weightError,
  type WeightState,
} from '../../../../../lib/weight';

function SpecDialog({
  product,
  variant,
  spec,
  purities,
  readOnly,
  onClose,
}: {
  product: Product;
  variant: Variant;
  spec: JewellerySpec | undefined;
  purities: PurityDefinition[];
  readOnly: boolean;
  onClose: () => void;
}) {
  const { api, tenantId } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const raw = (spec?.raw ?? {}) as Record<string, unknown>;
  const [form, setForm] = useState({
    purityId: spec?.purity.id ?? purities.find((p) => p.status === 'active')?.id ?? '',
    colour: spec?.colour ?? '',
    gross: spec ? fromRaw(raw.gross, spec.grossG) : emptyWeight(),
    net: spec ? fromRaw(raw.net, spec.netG) : emptyWeight(),
    stone: spec ? fromRaw(raw.stone, spec.stoneG) : emptyWeight(),
    enterFine: spec?.fineSource === 'entered',
    fine: spec?.fineSource === 'entered' ? fromRaw(raw.fine, spec.fineG) : emptyWeight(),
    billingBasis: spec?.billingBasis ?? 'net',
    qtyUnit: spec?.qtyUnit ?? 'piece',
    piecesPerUnit: String(spec?.piecesPerUnit ?? 1),
  });
  const [components, setComponents] = useState<ComponentRow[]>(toRows(spec?.components ?? []));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api<JewellerySpec>(`/v1/admin/products/${product.id}/variants/${variant.id}/jewellery-spec`, {
        method: 'PUT',
        body: {
          version: spec?.version,
          purityId: form.purityId,
          colour: form.colour || null,
          gross: toInput(form.gross),
          net: toInput(form.net),
          stone: toInput(form.stone),
          fine: form.enterFine ? toInput(form.fine) : null,
          billingBasis: form.billingBasis,
          qtyUnit: form.qtyUnit,
          piecesPerUnit: /^\d+$/.test(form.piecesPerUnit) ? Number.parseInt(form.piecesPerUnit, 10) : 0,
          components: toInputs(components),
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'products', product.id] });
      toast('Jewellery spec saved');
      onClose();
    },
    onError: (e) => {
      const r = serverErrors(e);
      setErrors(r.fields);
      setMessage(r.message);
    },
  });
  const w = (key: 'gross' | 'net' | 'stone' | 'fine') => (v: WeightState) =>
    setForm((f) => ({ ...f, [key]: v }));
  return (
    <Dialog
      open
      title={`Jewellery spec — ${variant.sku}`}
      onClose={onClose}
      footer={
        readOnly ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              Save spec
            </Button>
          </>
        )
      }
    >
      <p className="uc-muted" style={{ margin: 0 }}>
        Design (nominal) measurements. Each physical piece records its own actual weights as a serialized
        item.
      </p>
      <div className="uc-form-grid">
        <SelectField
          label="Metal / purity"
          value={form.purityId}
          error={errors.purityId}
          onChange={(e) => setForm({ ...form, purityId: e.target.value })}
          options={purities
            .filter((p) => p.status === 'active')
            .map((p) => ({
              value: p.id,
              label: `${p.metal} · ${p.label}${p.confirmedAt || p.source === 'merchant' ? '' : ' (unconfirmed)'}`,
            }))}
        />
        <TextField
          label="Colour"
          value={form.colour}
          onChange={(e) => setForm({ ...form, colour: e.target.value })}
          placeholder="yellow, white, rose…"
        />
        <WeightField
          label="Gross weight"
          value={form.gross}
          onChange={w('gross')}
          error={weightError(errors, 'gross')}
        />
        <WeightField
          label="Net (metal) weight"
          value={form.net}
          onChange={w('net')}
          error={weightError(errors, 'net')}
        />
        <WeightField
          label="Stone weight"
          value={form.stone}
          onChange={w('stone')}
          allowCarat
          error={weightError(errors, 'stone')}
        />
        <SelectField
          label="Billing basis"
          value={form.billingBasis}
          onChange={(e) => setForm({ ...form, billingBasis: e.target.value as typeof form.billingBasis })}
          options={[
            { value: 'gross', label: 'Gross weight' },
            { value: 'net', label: 'Net weight' },
            { value: 'fine', label: 'Fine weight' },
            { value: 'piece', label: 'Per piece' },
          ]}
          hint="Used by pricing (Phase 06)"
        />
        <SelectField
          label="Quantity unit"
          value={form.qtyUnit}
          onChange={(e) => setForm({ ...form, qtyUnit: e.target.value as typeof form.qtyUnit })}
          options={[
            { value: 'piece', label: 'Piece' },
            { value: 'pair', label: 'Pair' },
            { value: 'set', label: 'Set' },
          ]}
        />
        <TextField
          label="Pieces per unit"
          inputMode="numeric"
          value={form.piecesPerUnit}
          error={errors.piecesPerUnit}
          onChange={(e) => setForm({ ...form, piecesPerUnit: e.target.value })}
          hint="e.g. 2 for a pair of earrings"
        />
      </div>
      <Checkbox
        label="Enter fine weight manually (e.g. from hallmark certificate)"
        checked={form.enterFine}
        onChange={(e) => setForm({ ...form, enterFine: e.target.checked })}
        description="Otherwise computed as net × fineness, with provenance"
      />
      {form.enterFine && (
        <WeightField
          label="Fine weight"
          value={form.fine}
          onChange={w('fine')}
          error={weightError(errors, 'fine')}
        />
      )}
      <ComponentsEditor
        rows={components}
        onChange={setComponents}
        purities={purities}
        errors={errors}
        prefix="components"
      />
      {spec && <Checks checks={spec.checks} />}
      {message && <Alert tone="danger">{message}</Alert>}
    </Dialog>
  );
}

interface BulkRow {
  serialTag: string;
  huid: string;
  gross: string;
  net: string;
  stone: string;
}
const blankRow = (): BulkRow => ({ serialTag: '', huid: '', gross: '', net: '', stone: '' });

function BulkItemsDialog({ variant, onClose }: { variant: Variant; onClose: () => void }) {
  const { api, tenantId } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const [unit, setUnit] = useState<'g' | 'mg'>('g');
  const [rows, setRows] = useState<BulkRow[]>([blankRow(), blankRow(), blankRow()]);
  const [paste, setPaste] = useState('');
  const [preview, setPreview] = useState<BulkSerialItemsResponse | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const filled = rows.filter((r) => r.serialTag || r.gross || r.net);
  const body = (dryRun: boolean) => ({
    variantId: variant.id,
    dryRun,
    items: filled.map((r) => ({
      serialTag: r.serialTag.trim(),
      huid: r.huid.trim() || null,
      gross: { value: r.gross.trim(), unit },
      net: { value: r.net.trim(), unit },
      ...(r.stone.trim() ? { stone: { value: r.stone.trim(), unit } } : {}),
    })),
  });
  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      api<BulkSerialItemsResponse>('/v1/admin/serial-items/bulk', { method: 'POST', body: body(dryRun) }),
    onSuccess: (res) => {
      setErrors({});
      if (res.dryRun) setPreview(res);
      else {
        void qc.invalidateQueries({ queryKey: ['t', tenantId] });
        toast(`${res.created} items created`);
        onClose();
      }
    },
    onError: (e) => {
      setPreview(null);
      setErrors(serverErrors(e).fields);
    },
  });
  function applyPaste() {
    // Tab- or comma-separated: tag, HUID, gross, net, stone (one piece per line, e.g. pasted from a spreadsheet).
    const parsed = paste
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [serialTag = '', huid = '', gross = '', net = '', stone = ''] = l
          .split(/\t|,/)
          .map((c) => c.trim());
        return { serialTag, huid, gross, net, stone };
      });
    if (parsed.length) {
      setRows(parsed);
      setPaste('');
      setPreview(null);
    }
  }
  const rowError = (i: number) =>
    Object.entries(errors)
      .filter(([k]) => k.startsWith(`items.${i}.`))
      .map(([k, v]) => `${k.split('.').slice(2).join('.')}: ${v}`)
      .join('; ');
  const set = (i: number, patch: Partial<BulkRow>) => {
    setPreview(null);
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  return (
    <Dialog
      open
      title={`Add pieces — ${variant.sku}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            disabled={filled.length === 0}
            loading={run.isPending && run.variables === true}
            onClick={() => run.mutate(true)}
          >
            Preview
          </Button>
          <Button
            variant="primary"
            disabled={!preview}
            loading={run.isPending && run.variables === false}
            onClick={() => run.mutate(false)}
          >
            Create {filled.length} item(s)
          </Button>
        </>
      }
    >
      <p className="uc-muted" style={{ margin: 0 }}>
        One row per physical piece with its actual weights. Preview validates everything first; nothing is
        saved until you create.
      </p>
      <SelectField
        label="Weight unit for all rows"
        value={unit}
        onChange={(e) => {
          setUnit(e.target.value as 'g' | 'mg');
          setPreview(null);
        }}
        options={[
          { value: 'g', label: 'grams' },
          { value: 'mg', label: 'milligrams' },
        ]}
      />
      <div className="uc-field">
        <label htmlFor="bulk-paste">Paste rows (tag, HUID, gross, net, stone)</label>
        <textarea
          id="bulk-paste"
          className="uc-textarea"
          rows={3}
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder={'TAG-001\tAB12CD\t4.612\t4.612\t0'}
        />
        <Button size="sm" style={{ alignSelf: 'flex-start' }} disabled={!paste.trim()} onClick={applyPaste}>
          Use pasted rows
        </Button>
      </div>
      <div className="uc-table-wrap">
        <table className="uc-table">
          <caption className="uc-sr-only">Pieces to add</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Tag</th>
              <th scope="col">HUID</th>
              <th scope="col">Gross</th>
              <th scope="col">Net</th>
              <th scope="col">Stone</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const p = preview?.rows.find((x) => x.serialTag === r.serialTag.trim());
              const err = rowError(filled.indexOf(r));
              return (
                <tr key={i}>
                  <td>{i + 1}</td>
                  {(['serialTag', 'huid', 'gross', 'net', 'stone'] as const).map((k) => (
                    <td key={k}>
                      <input
                        className="uc-input"
                        aria-label={`Row ${i + 1} ${k}`}
                        inputMode={k === 'serialTag' || k === 'huid' ? undefined : 'decimal'}
                        value={r[k]}
                        onChange={(e) => set(i, { [k]: e.target.value })}
                        style={{ minWidth: k === 'serialTag' ? 110 : 80 }}
                      />
                    </td>
                  ))}
                  <td style={{ minWidth: 160 }}>
                    {err ? (
                      <span className="uc-error">{err}</span>
                    ) : p ? (
                      <>
                        fine {grams(p.fineG)} <StatusBadge status={p.status} />
                        {p.checks.filter((c) => c.severity === 'warning').length > 0 && (
                          <Badge tone="warning">check</Badge>
                        )}
                      </>
                    ) : (
                      <span className="uc-muted">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Button
        size="sm"
        style={{ alignSelf: 'flex-start' }}
        onClick={() => setRows((rs) => [...rs, blankRow()])}
      >
        Add row
      </Button>
      {Object.keys(errors).length > 0 && (
        <Alert tone="danger">Fix the highlighted rows. Nothing was saved.</Alert>
      )}
      {preview && (
        <Alert tone="success">
          All {preview.rows.length} rows are valid. Review the computed fine weights, then create.
        </Alert>
      )}
      {run.error && Object.keys(errors).length === 0 && (
        <Alert tone="danger">{errorMessage(run.error)}</Alert>
      )}
    </Dialog>
  );
}

export function JewelleryCard({ product }: { product: Product }) {
  const { can, tenantId, context } = useTenant();
  const purities = useTenantQuery<{ items: PurityDefinition[] }>(
    ['purities'],
    '/v1/admin/jewellery/purities',
    undefined,
    context.features.includes('jewellery'),
  );
  const [specFor, setSpecFor] = useState<Variant | null>(null);
  const [bulkFor, setBulkFor] = useState<Variant | null>(null);
  if (!product.jewellery || !context.features.includes('jewellery')) return null;
  const specs = new Map(product.jewellery.specs.map((s) => [s.variantId, s]));
  const edit = can('jewellery.edit') && product.status !== 'archived';
  const serial = context.features.includes('serialized_items');
  return (
    <Card title="Jewellery measurements">
      <DataTable
        caption="Jewellery measurements per variant"
        rows={product.variants}
        rowKey={(v) => v.id}
        empty={<EmptyState title="No variants" />}
        columns={[
          { key: 'sku', header: 'Variant', render: (v) => <span className="uc-mono">{v.sku}</span> },
          {
            key: 'purity',
            header: 'Metal / purity',
            render: (v) =>
              specs.get(v.id) ? (
                `${specs.get(v.id)!.metal} ${specs.get(v.id)!.purity.label}`
              ) : (
                <span className="uc-muted">No spec</span>
              ),
          },
          {
            key: 'weights',
            header: 'Design gross / net / stone',
            render: (v) => {
              const s = specs.get(v.id);
              return s ? `${grams(s.grossG)} / ${grams(s.netG)} / ${grams(s.stoneG)}` : '—';
            },
          },
          {
            key: 'fine',
            header: 'Fine',
            render: (v) => {
              const s = specs.get(v.id);
              return s?.fineG ? (
                <>
                  {grams(s.fineG)} <Badge>{s.fineSource}</Badge>
                </>
              ) : (
                '—'
              );
            },
          },
          {
            key: 'checks',
            header: 'Checks',
            render: (v) => {
              const s = specs.get(v.id);
              const warn = s?.checks.filter((c) => c.severity === 'warning').length ?? 0;
              return s ? (
                warn ? (
                  <Badge tone="warning">{warn} warning(s)</Badge>
                ) : (
                  <Badge tone="success">OK</Badge>
                )
              ) : (
                '—'
              );
            },
          },
          ...(serial
            ? [
                {
                  key: 'items',
                  header: 'Pieces',
                  render: (v: Variant) => (
                    <Link href={`/t/${tenantId}/serial-items?variantId=${v.id}`}>
                      {product.jewellery!.serialItemCounts[v.id] ?? 0}
                      <span className="uc-sr-only"> pieces of {v.sku}</span>
                    </Link>
                  ),
                },
              ]
            : []),
          {
            key: 'actions',
            header: 'Actions',
            render: (v) => (
              <span className="uc-row">
                <Button size="sm" disabled={!purities.data} onClick={() => setSpecFor(v)}>
                  {edit ? 'Edit spec' : 'View spec'}
                  <span className="uc-sr-only"> for {v.sku}</span>
                </Button>
                {edit && serial && specs.has(v.id) && (
                  <Button size="sm" onClick={() => setBulkFor(v)}>
                    Add pieces<span className="uc-sr-only"> of {v.sku}</span>
                  </Button>
                )}
              </span>
            ),
          },
        ]}
      />
      {specFor && purities.data && (
        <SpecDialog
          product={product}
          variant={specFor}
          spec={specs.get(specFor.id)}
          purities={purities.data.items}
          readOnly={!edit}
          onClose={() => setSpecFor(null)}
        />
      )}
      {bulkFor && <BulkItemsDialog variant={bulkFor} onClose={() => setBulkFor(null)} />}
    </Card>
  );
}
