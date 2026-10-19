'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  SaveRuleDraftRequest,
  type CalculateResponse,
  type PriceRule,
  type PriceRuleVersion,
  type PricingCatalogOptions,
} from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  DataTable,
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
  useUnsavedChangesWarning,
} from '@uc/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { serverErrors, validate } from '../../../../../../lib/forms';
import { BreakdownTable, PricingTabs } from '../../../../../../lib/pricing';
import { useTenant, useTenantQuery } from '../../../../../../lib/tenant';

const METALS = ['gold', 'silver', 'platinum', 'palladium', 'other'] as const;
const GROUPS = ['metal', 'making', 'wastage', 'stones', 'charges', 'list_price'] as const;
const BASIS = [
  { value: 'item', label: "Item's billing basis" },
  { value: 'gross', label: 'Gross weight' },
  { value: 'net', label: 'Net weight' },
  { value: 'fine', label: 'Fine weight' },
];

/** Editable form state: all numbers stay strings (exact decimals); converted to the DSL on save. */
interface Form {
  priority: string;
  notes: string;
  productTypes: string[];
  metals: string[];
  purityIds: string[];
  categoryIds: string[];
  baseKind: 'metal' | 'list_price';
  weightBasis: string;
  makingMode: string;
  makingAmount: string;
  makingPercent: string;
  makingBasis: string;
  tiers: { upToG: string; amount: string }[];
  wastageOn: boolean;
  wastagePercent: string;
  wastageBasis: string;
  stonesOn: boolean;
  stonesMode: string;
  stoneRates: { kind: string; grade: string; amount: string }[];
  charges: { code: string; label: string; mode: string; amount: string }[];
  discountOn: boolean;
  discountMode: string;
  discountValue: string;
  discountApplies: string[];
  taxRuleId: string;
}

function toForm(v: PriceRuleVersion): Form {
  const d = v.definition;
  const m = d.making;
  return {
    priority: String(v.priority),
    notes: v.notes ?? '',
    productTypes: v.conditions.productTypes,
    metals: v.conditions.metals,
    purityIds: v.conditions.purityIds,
    categoryIds: v.conditions.categoryIds,
    baseKind: d.base.kind,
    weightBasis: d.base.kind === 'metal' ? d.base.weightBasis : 'item',
    makingMode: m.mode,
    makingAmount: 'amount' in m ? m.amount : '',
    makingPercent: m.mode === 'percent_of_metal' ? m.percent : '',
    makingBasis:
      (m.mode === 'per_gram' || m.mode === 'tiered_per_gram') && m.weightBasis ? m.weightBasis : '',
    tiers:
      m.mode === 'tiered_per_gram'
        ? m.tiers.map((t) => ({ upToG: t.upToG ?? '', amount: t.amount }))
        : [{ upToG: '', amount: '' }],
    wastageOn: Boolean(d.wastage),
    wastagePercent: d.wastage?.percent ?? '',
    wastageBasis: d.wastage?.weightBasis ?? '',
    stonesOn: Boolean(d.stones),
    stonesMode: d.stones?.mode ?? 'per_carat',
    stoneRates: d.stones?.rates.map((r) => ({ kind: r.kind, grade: r.grade ?? '', amount: r.amount })) ?? [
      { kind: 'diamond', grade: '', amount: '' },
    ],
    charges: d.charges.map((c) => ({ ...c })),
    discountOn: Boolean(d.discount),
    discountMode: d.discount?.mode ?? 'percent',
    discountValue: d.discount?.value ?? '',
    discountApplies: d.discount?.appliesTo ?? ['making'],
    taxRuleId: d.taxRuleId ?? '',
  };
}

function toDefinition(f: Form): unknown {
  const making =
    f.makingMode === 'none'
      ? { mode: 'none' }
      : f.makingMode === 'percent_of_metal'
        ? { mode: 'percent_of_metal', percent: f.makingPercent.trim() }
        : f.makingMode === 'tiered_per_gram'
          ? {
              mode: 'tiered_per_gram',
              ...(f.makingBasis ? { weightBasis: f.makingBasis } : {}),
              tiers: f.tiers.map((t, i) => ({
                upToG: i === f.tiers.length - 1 ? null : t.upToG.trim(),
                amount: t.amount.trim(),
              })),
            }
          : {
              mode: f.makingMode,
              amount: f.makingAmount.trim(),
              ...(f.makingMode === 'per_gram' && f.makingBasis ? { weightBasis: f.makingBasis } : {}),
            };
  return {
    base: f.baseKind === 'metal' ? { kind: 'metal', weightBasis: f.weightBasis } : { kind: 'list_price' },
    making,
    wastage: f.wastageOn
      ? { percent: f.wastagePercent.trim(), ...(f.wastageBasis ? { weightBasis: f.wastageBasis } : {}) }
      : null,
    stones: f.stonesOn
      ? {
          mode: f.stonesMode,
          rates: f.stoneRates.map((r) => ({
            kind: r.kind,
            grade: r.grade.trim() || null,
            amount: r.amount.trim(),
          })),
        }
      : null,
    charges: f.charges.map((c) => ({ ...c, label: c.label.trim(), amount: c.amount.trim() })),
    discount: f.discountOn
      ? { mode: f.discountMode, value: f.discountValue.trim(), appliesTo: f.discountApplies }
      : null,
    taxRuleId: f.taxRuleId || null,
  };
}

function toggle(list: string[], value: string, on: boolean) {
  return on ? [...new Set([...list, value])] : list.filter((x) => x !== value);
}

function Editor({
  rule,
  version,
  readOnly,
}: {
  rule: PriceRule;
  version: PriceRuleVersion;
  readOnly: boolean;
}) {
  const { api, tenantId, context } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const options = useTenantQuery<PricingCatalogOptions>(['pricing', 'options'], '/v1/admin/pricing/options');
  const initial = useMemo(() => toForm(version), [version]);
  const [f, setF] = useState<Form>(initial);
  useEffect(() => setF(initial), [initial]);
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);
  useUnsavedChangesWarning(dirty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((prev) => ({ ...prev, [k]: v }));
  const save = useMutation({
    mutationFn: (body: unknown) =>
      api<PriceRule>(`/v1/admin/pricing/rules/${rule.id}/draft`, { method: 'PUT', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'pricing'] });
      setErrors({});
      setMessage(null);
      toast('Draft saved');
    },
    onError: (e) => {
      const r = serverErrors(e);
      setErrors(r.fields);
      setMessage(r.message);
    },
  });
  function submit() {
    const body = {
      ...(rule.draft ? { lockVersion: rule.draft.lockVersion } : {}),
      priority: /^\d{1,4}$/.test(f.priority) ? Number.parseInt(f.priority, 10) : -1,
      notes: f.notes.trim() || null,
      conditions: {
        productTypes: f.productTypes,
        metals: f.metals,
        purityIds: f.purityIds,
        categoryIds: f.categoryIds,
      },
      definition: toDefinition(f),
    };
    const check = validate(SaveRuleDraftRequest, body);
    if (!check.ok) {
      setErrors(check.errors);
      setMessage('Fix the highlighted fields');
      return;
    }
    save.mutate(body);
  }
  const err = (path: string) => errors[path] ?? errors[`definition.${path}`];
  const jewellery = context.features.includes('metal_rates');
  return (
    <Card
      title={
        readOnly
          ? `Version ${version.version} (${version.status})`
          : rule.draft
            ? `Draft v${rule.draft.version}`
            : 'New draft (from the published version)'
      }
      actions={
        !readOnly && (
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={submit}
            disabled={!dirty && Boolean(rule.draft)}
          >
            Save draft
          </Button>
        )
      }
    >
      <fieldset disabled={readOnly} className="uc-stack" style={{ border: 0, padding: 0 }}>
        <h3>Applies to</h3>
        <div className="uc-form-grid">
          <TextField
            label="Priority (higher wins)"
            inputMode="numeric"
            value={f.priority}
            error={errors.priority}
            onChange={(e) => set('priority', e.target.value)}
          />
        </div>
        <div className="uc-row" style={{ flexWrap: 'wrap' }} role="group" aria-label="Product types">
          {['jewellery', 'standard'].map((t) => (
            <Checkbox
              key={t}
              label={`${t} products`}
              checked={f.productTypes.includes(t)}
              onChange={(e) => set('productTypes', toggle(f.productTypes, t, e.target.checked))}
            />
          ))}
        </div>
        {jewellery && (
          <>
            <div className="uc-row" style={{ flexWrap: 'wrap' }} role="group" aria-label="Metals">
              {METALS.map((m) => (
                <Checkbox
                  key={m}
                  label={m}
                  checked={f.metals.includes(m)}
                  onChange={(e) => set('metals', toggle(f.metals, m, e.target.checked))}
                />
              ))}
            </div>
            <div className="uc-row" style={{ flexWrap: 'wrap' }} role="group" aria-label="Purities">
              {(options.data?.purities ?? []).map((p) => (
                <Checkbox
                  key={p.id}
                  label={p.label}
                  checked={f.purityIds.includes(p.id)}
                  onChange={(e) => set('purityIds', toggle(f.purityIds, p.id, e.target.checked))}
                />
              ))}
            </div>
          </>
        )}
        <span className="uc-muted">
          Nothing ticked in a group means &quot;any&quot;.
          {f.categoryIds.length > 0 && ` Also limited to ${f.categoryIds.length} categor(ies).`}
        </span>

        <h3>Price base</h3>
        <div className="uc-form-grid">
          <SelectField
            label="Base"
            value={f.baseKind}
            onChange={(e) => set('baseKind', e.target.value as Form['baseKind'])}
            options={[
              ...(jewellery ? [{ value: 'metal', label: 'Metal value: weight × approved rate' }] : []),
              { value: 'list_price', label: 'List price from the book' },
            ]}
          />
          {f.baseKind === 'metal' && (
            <SelectField
              label="Weight for metal value"
              value={f.weightBasis}
              onChange={(e) => set('weightBasis', e.target.value)}
              options={BASIS}
            />
          )}
        </div>

        <h3>Making charge</h3>
        <div className="uc-form-grid">
          <SelectField
            label="Mode"
            value={f.makingMode}
            onChange={(e) => set('makingMode', e.target.value)}
            options={[
              { value: 'none', label: 'None' },
              { value: 'per_gram', label: 'Per gram' },
              { value: 'tiered_per_gram', label: 'Per gram, tiered by weight' },
              { value: 'per_piece', label: 'Per piece' },
              ...(f.baseKind === 'metal' ? [{ value: 'percent_of_metal', label: '% of metal value' }] : []),
              { value: 'per_line', label: 'Fixed per line' },
            ]}
          />
          {['per_gram', 'per_piece', 'per_line'].includes(f.makingMode) && (
            <TextField
              label="Amount"
              inputMode="decimal"
              value={f.makingAmount}
              error={err('making.amount')}
              onChange={(e) => set('makingAmount', e.target.value)}
            />
          )}
          {f.makingMode === 'percent_of_metal' && (
            <TextField
              label="Percent of metal value"
              inputMode="decimal"
              value={f.makingPercent}
              error={err('making.percent')}
              onChange={(e) => set('makingPercent', e.target.value)}
            />
          )}
          {(f.makingMode === 'per_gram' || f.makingMode === 'tiered_per_gram') && (
            <SelectField
              label="Weight for making"
              value={f.makingBasis}
              onChange={(e) => set('makingBasis', e.target.value)}
              options={[{ value: '', label: 'Same as metal value' }, ...BASIS]}
            />
          )}
        </div>
        {f.makingMode === 'tiered_per_gram' && (
          <div className="uc-stack">
            {f.tiers.map((t, i) => (
              <div key={i} className="uc-row">
                <TextField
                  label={
                    i === f.tiers.length - 1
                      ? `Tier ${i + 1}: above previous limit`
                      : `Tier ${i + 1}: up to (g per piece)`
                  }
                  inputMode="decimal"
                  value={i === f.tiers.length - 1 ? '' : t.upToG}
                  disabled={i === f.tiers.length - 1}
                  error={err(`making.tiers.${i}.upToG`)}
                  onChange={(e) =>
                    set(
                      'tiers',
                      f.tiers.map((x, j) => (j === i ? { ...x, upToG: e.target.value } : x)),
                    )
                  }
                />
                <TextField
                  label={`Tier ${i + 1} amount per gram`}
                  inputMode="decimal"
                  value={t.amount}
                  error={err(`making.tiers.${i}.amount`)}
                  onChange={(e) =>
                    set(
                      'tiers',
                      f.tiers.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)),
                    )
                  }
                />
                {f.tiers.length > 1 && (
                  <Button
                    size="sm"
                    onClick={() =>
                      set(
                        'tiers',
                        f.tiers.filter((_, j) => j !== i),
                      )
                    }
                  >
                    Remove<span className="uc-sr-only"> tier {i + 1}</span>
                  </Button>
                )}
              </div>
            ))}
            <Button size="sm" onClick={() => set('tiers', [{ upToG: '', amount: '' }, ...f.tiers])}>
              Add tier
            </Button>
          </div>
        )}

        {f.baseKind === 'metal' && (
          <>
            <h3>Wastage</h3>
            <Checkbox
              label="Charge wastage (added weight valued at the metal rate)"
              checked={f.wastageOn}
              onChange={(e) => set('wastageOn', e.target.checked)}
            />
            {f.wastageOn && (
              <div className="uc-form-grid">
                <TextField
                  label="Wastage % of weight"
                  inputMode="decimal"
                  value={f.wastagePercent}
                  error={err('wastage.percent')}
                  onChange={(e) => set('wastagePercent', e.target.value)}
                />
                <SelectField
                  label="Weight for wastage"
                  value={f.wastageBasis}
                  onChange={(e) => set('wastageBasis', e.target.value)}
                  options={[{ value: '', label: 'Same as metal value' }, ...BASIS]}
                />
              </div>
            )}
          </>
        )}

        {jewellery && (
          <>
            <h3>Stones</h3>
            <Checkbox
              label="Price recorded stones"
              checked={f.stonesOn}
              onChange={(e) => set('stonesOn', e.target.checked)}
            />
            {f.stonesOn && (
              <div className="uc-stack">
                <SelectField
                  label="Stone pricing"
                  value={f.stonesMode}
                  onChange={(e) => set('stonesMode', e.target.value)}
                  options={[
                    { value: 'per_carat', label: 'Per carat' },
                    { value: 'per_piece', label: 'Per stone' },
                  ]}
                />
                {f.stoneRates.map((r, i) => (
                  <div key={i} className="uc-row" style={{ flexWrap: 'wrap' }}>
                    <SelectField
                      label={`Stone ${i + 1} kind`}
                      value={r.kind}
                      onChange={(e) =>
                        set(
                          'stoneRates',
                          f.stoneRates.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)),
                        )
                      }
                      options={['diamond', 'gemstone', 'pearl', 'other'].map((k) => ({ value: k, label: k }))}
                    />
                    <TextField
                      label={`Stone ${i + 1} grade (empty = any)`}
                      value={r.grade}
                      onChange={(e) =>
                        set(
                          'stoneRates',
                          f.stoneRates.map((x, j) => (j === i ? { ...x, grade: e.target.value } : x)),
                        )
                      }
                    />
                    <TextField
                      label={`Stone ${i + 1} amount`}
                      inputMode="decimal"
                      value={r.amount}
                      error={err(`stones.rates.${i}.amount`)}
                      onChange={(e) =>
                        set(
                          'stoneRates',
                          f.stoneRates.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)),
                        )
                      }
                    />
                    <Button
                      size="sm"
                      onClick={() =>
                        set(
                          'stoneRates',
                          f.stoneRates.filter((_, j) => j !== i),
                        )
                      }
                    >
                      Remove<span className="uc-sr-only"> stone rate {i + 1}</span>
                    </Button>
                  </div>
                ))}
                <Button
                  size="sm"
                  onClick={() =>
                    set('stoneRates', [...f.stoneRates, { kind: 'diamond', grade: '', amount: '' }])
                  }
                >
                  Add stone rate
                </Button>
                <span className="uc-muted">
                  A recorded stone without a matching rate makes the price fail — it is never priced at zero.
                </span>
              </div>
            )}
          </>
        )}

        <h3>Other charges</h3>
        {f.charges.map((c, i) => (
          <div key={i} className="uc-row" style={{ flexWrap: 'wrap' }}>
            <SelectField
              label={`Charge ${i + 1} type`}
              value={c.code}
              onChange={(e) =>
                set(
                  'charges',
                  f.charges.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)),
                )
              }
              options={['hallmark', 'certificate', 'packing', 'labour', 'other'].map((k) => ({
                value: k,
                label: k,
              }))}
            />
            <TextField
              label={`Charge ${i + 1} label`}
              value={c.label}
              error={err(`charges.${i}.label`)}
              onChange={(e) =>
                set(
                  'charges',
                  f.charges.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                )
              }
            />
            <SelectField
              label={`Charge ${i + 1} basis`}
              value={c.mode}
              onChange={(e) =>
                set(
                  'charges',
                  f.charges.map((x, j) => (j === i ? { ...x, mode: e.target.value } : x)),
                )
              }
              options={[
                { value: 'per_piece', label: 'Per piece' },
                { value: 'per_gram', label: 'Per gram' },
                { value: 'per_line', label: 'Per line' },
              ]}
            />
            <TextField
              label={`Charge ${i + 1} amount`}
              inputMode="decimal"
              value={c.amount}
              error={err(`charges.${i}.amount`)}
              onChange={(e) =>
                set(
                  'charges',
                  f.charges.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)),
                )
              }
            />
            <Button
              size="sm"
              onClick={() =>
                set(
                  'charges',
                  f.charges.filter((_, j) => j !== i),
                )
              }
            >
              Remove<span className="uc-sr-only"> charge {i + 1}</span>
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          onClick={() =>
            set('charges', [...f.charges, { code: 'other', label: '', mode: 'per_piece', amount: '' }])
          }
        >
          Add charge
        </Button>

        <h3>Discount</h3>
        <Checkbox
          label="Apply a discount"
          checked={f.discountOn}
          onChange={(e) => set('discountOn', e.target.checked)}
        />
        {f.discountOn && (
          <>
            <div className="uc-form-grid">
              <SelectField
                label="Discount type"
                value={f.discountMode}
                onChange={(e) => set('discountMode', e.target.value)}
                options={[
                  { value: 'percent', label: 'Percent' },
                  { value: 'fixed', label: 'Fixed amount per line' },
                ]}
              />
              <TextField
                label="Discount value"
                inputMode="decimal"
                value={f.discountValue}
                error={err('discount.value')}
                onChange={(e) => set('discountValue', e.target.value)}
              />
            </div>
            <div
              className="uc-row"
              style={{ flexWrap: 'wrap' }}
              role="group"
              aria-label="Discount applies to"
            >
              {GROUPS.map((g) => (
                <Checkbox
                  key={g}
                  label={`on ${g.replace('_', ' ')}`}
                  checked={f.discountApplies.includes(g)}
                  onChange={(e) => set('discountApplies', toggle(f.discountApplies, g, e.target.checked))}
                />
              ))}
            </div>
          </>
        )}

        <h3>Tax</h3>
        <SelectField
          label="Tax rule"
          value={f.taxRuleId}
          onChange={(e) => set('taxRuleId', e.target.value)}
          options={[
            { value: '', label: 'No tax in this price' },
            ...(options.data?.taxRules ?? []).map((t) => ({
              value: t.id,
              label: `${t.label} (${t.status.replace('_', ' ')})`,
            })),
          ]}
          hint="Tax rules are merchant data pending accountant validation (Settings & tax)"
        />
        <TextField label="Notes" value={f.notes} onChange={(e) => set('notes', e.target.value)} />
      </fieldset>
      {message && <Alert tone="danger">{message}</Alert>}
    </Card>
  );
}

function TestPanel({ version }: { version: PriceRuleVersion }) {
  const { api, context } = useTenant();
  const options = useTenantQuery<PricingCatalogOptions>(['pricing', 'options'], '/v1/admin/pricing/options');
  const jewellery = context.features.includes('metal_rates');
  const [m, setM] = useState({
    purityId: '',
    grossG: '',
    netG: '',
    fineG: '',
    billingBasis: 'net',
    quantity: '1',
    listPrice: '',
  });
  const calc = useMutation({
    mutationFn: () =>
      api<CalculateResponse>('/v1/admin/pricing/calculate', {
        method: 'POST',
        body: {
          ruleVersionId: version.id,
          manual: {
            productType: jewellery ? 'jewellery' : 'standard',
            purityId: m.purityId || null,
            grossG: m.grossG.trim() || null,
            netG: m.netG.trim() || null,
            fineG: m.fineG.trim() || null,
            billingBasis: m.billingBasis || null,
            quantity: /^\d{1,5}$/.test(m.quantity) ? Number.parseInt(m.quantity, 10) : 0,
            listPrice: m.listPrice.trim() || null,
          },
        },
      }),
  });
  return (
    <Card title={`Test v${version.version} (${version.status}) on sample measurements`}>
      <div className="uc-form-grid">
        {jewellery && (
          <>
            <SelectField
              label="Purity"
              value={m.purityId}
              onChange={(e) => setM({ ...m, purityId: e.target.value })}
              options={[
                { value: '', label: 'None' },
                ...(options.data?.purities ?? []).map((p) => ({ value: p.id, label: p.label })),
              ]}
            />
            <TextField
              label="Gross g"
              inputMode="decimal"
              value={m.grossG}
              onChange={(e) => setM({ ...m, grossG: e.target.value })}
            />
            <TextField
              label="Net g"
              inputMode="decimal"
              value={m.netG}
              onChange={(e) => setM({ ...m, netG: e.target.value })}
            />
            <TextField
              label="Fine g"
              inputMode="decimal"
              value={m.fineG}
              onChange={(e) => setM({ ...m, fineG: e.target.value })}
            />
            <SelectField
              label="Billing basis"
              value={m.billingBasis}
              onChange={(e) => setM({ ...m, billingBasis: e.target.value })}
              options={['gross', 'net', 'fine', 'piece'].map((b) => ({ value: b, label: b }))}
            />
          </>
        )}
        <TextField
          label="List price (per piece)"
          inputMode="decimal"
          value={m.listPrice}
          onChange={(e) => setM({ ...m, listPrice: e.target.value })}
        />
        <TextField
          label="Quantity"
          inputMode="numeric"
          value={m.quantity}
          onChange={(e) => setM({ ...m, quantity: e.target.value })}
        />
      </div>
      <Button variant="primary" loading={calc.isPending} onClick={() => calc.mutate()}>
        Calculate
      </Button>
      <span className="uc-muted">
        Uses the saved version and the current approved rate. Nothing is stored.
      </span>
      {calc.error && <Alert tone="danger">{errorMessage(calc.error)}</Alert>}
      {calc.data && <BreakdownTable breakdown={calc.data.line.breakdown} caption="Test calculation" />}
    </Card>
  );
}

export default function PriceRulePage() {
  const { ruleId } = useParams<{ ruleId: string }>();
  const { api, can, tenantId, context } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const enabled = can('pricing.read') && context.features.includes('pricing');
  const rule = useTenantQuery<PriceRule>(
    ['pricing', 'rule', ruleId],
    `/v1/admin/pricing/rules/${ruleId}`,
    undefined,
    enabled,
  );
  const [retiring, setRetiring] = useState(false);
  const publish = useMutation({
    mutationFn: (versionId: string) =>
      api(`/v1/admin/pricing/rules/${ruleId}/publish`, { method: 'POST', body: { versionId } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'pricing'] });
      toast('Rule published');
    },
  });
  const retire = useMutation({
    mutationFn: (reason: string) =>
      api(`/v1/admin/pricing/rules/${ruleId}/retire`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'pricing'] });
      setRetiring(false);
      toast('Rule retired');
    },
  });
  if (!enabled) return <ForbiddenState />;
  if (rule.error) return <ErrorState error={rule.error} onRetry={() => void rule.refetch()} />;
  if (!rule.data) return <LoadingState />;
  const r = rule.data;
  const editable = can('pricing.edit') && r.status !== 'retired';
  const shown = r.draft ?? r.published ?? r.versions[0]!;
  const tz = context.tenant.timezone;
  const selfAuthored = r.draft?.createdBy?.id === context.user.id;
  return (
    <>
      <PageHeader
        title={r.name}
        description={
          <>
            <Link href={`/t/${tenantId}/pricing/books/${r.bookId}`}>Back to price book</Link> · Published
            versions are immutable; edits create a new draft.
          </>
        }
        actions={
          <>
            {can('pricing.publish') && r.draft && (
              <Button
                variant="primary"
                loading={publish.isPending}
                onClick={() => publish.mutate(r.draft!.id)}
              >
                Publish draft v{r.draft.version}
              </Button>
            )}
            {can('pricing.publish') && r.status !== 'retired' && (
              <Button variant="danger" onClick={() => setRetiring(true)}>
                Retire
              </Button>
            )}
          </>
        }
      />
      <PricingTabs />
      <div className="uc-row" style={{ flexWrap: 'wrap' }}>
        {r.status === 'published' && <Badge tone="success">published v{r.published!.version}</Badge>}
        {r.status === 'retired' && <Badge>retired</Badge>}
        {r.draft && (
          <Badge tone="info">
            draft v{r.draft.version} by {r.draft.createdBy?.name ?? '—'}
          </Badge>
        )}
      </div>
      {r.draft && selfAuthored && can('pricing.publish') && (
        <Alert tone="info">You saved this draft. When rule review is on, someone else must publish it.</Alert>
      )}
      {publish.error && <Alert tone="danger">{errorMessage(publish.error)}</Alert>}
      <Editor rule={r} version={shown} readOnly={!editable} />
      <TestPanel version={shown} />
      <Card title="Versions">
        <DataTable
          caption="Rule versions"
          rows={r.versions}
          rowKey={(v) => v.id}
          empty={<EmptyState title="No versions" />}
          columns={[
            { key: 'v', header: 'Version', render: (v) => `v${v.version}` },
            {
              key: 'status',
              header: 'Status',
              render: (v) => (
                <Badge
                  tone={v.status === 'published' ? 'success' : v.status === 'draft' ? 'info' : undefined}
                >
                  {v.status}
                </Badge>
              ),
            },
            { key: 'prio', header: 'Priority', render: (v) => v.priority },
            {
              key: 'by',
              header: 'Edited by',
              render: (v) => `${v.createdBy?.name ?? '—'} · ${formatDateTime(v.createdAt, tz)}`,
            },
            {
              key: 'pub',
              header: 'Published',
              render: (v) =>
                v.publishedAt ? `${v.publishedBy?.name ?? '—'} · ${formatDateTime(v.publishedAt, tz)}` : '—',
            },
          ]}
        />
      </Card>
      <ConfirmDialog
        open={retiring}
        title={`Retire ${r.name}`}
        description="The rule stops pricing new quotes. Existing quotes keep the version they used."
        confirmLabel="Retire"
        tone="danger"
        requireReason
        loading={retire.isPending}
        error={retire.error ? errorMessage(retire.error) : null}
        onConfirm={(reason) => retire.mutate(reason)}
        onClose={() => setRetiring(false)}
      />
    </>
  );
}
