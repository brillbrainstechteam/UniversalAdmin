'use client';

import type { Component, ComponentInput, PurityDefinition } from '@uc/contracts';
import { Button, SelectField, TextField } from '@uc/ui';
import { WeightField, fromRaw, toInput, weightError, type WeightState } from './weight';

export interface ComponentRow {
  kind: ComponentInput['kind'];
  description: string;
  count: string;
  weight: WeightState;
  purityId: string;
}

const KINDS = [
  { value: 'diamond', label: 'Diamond' },
  { value: 'gemstone', label: 'Gemstone' },
  { value: 'pearl', label: 'Pearl' },
  { value: 'metal', label: 'Metal (multi-metal piece)' },
  { value: 'other', label: 'Other' },
];

export const toRows = (components: Component[]): ComponentRow[] =>
  components.map((c) => ({
    kind: c.kind,
    description: c.description,
    count: String(c.count),
    weight: fromRaw((c.raw as { weight?: unknown }).weight, c.weightG),
    purityId: c.purity?.id ?? '',
  }));

export const toInputs = (rows: ComponentRow[]) =>
  rows.map((r) => ({
    kind: r.kind,
    description: r.description,
    count: /^\d+$/.test(r.count) ? Number.parseInt(r.count, 10) : 0,
    weight: toInput(r.weight) ?? { value: '', unit: r.weight.unit },
    purityId: r.kind === 'metal' ? r.purityId || null : null,
  }));

export function ComponentsEditor({
  rows,
  onChange,
  purities,
  errors,
  prefix,
  disabled,
}: {
  rows: ComponentRow[];
  onChange: (rows: ComponentRow[]) => void;
  purities: PurityDefinition[];
  errors: Record<string, string>;
  prefix: string;
  disabled?: boolean;
}) {
  const set = (i: number, patch: Partial<ComponentRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="uc-fieldset">
      <legend>Components (stones, other metals)</legend>
      {rows.length === 0 && (
        <span className="uc-muted">
          None. Add stones to cross-check the stone weight; add metal parts for multi-metal pieces.
        </span>
      )}
      {rows.map((r, i) => (
        <div key={i} className="uc-form-grid" style={{ alignItems: 'end' }}>
          <SelectField
            label={`Component ${i + 1} type`}
            value={r.kind}
            disabled={disabled}
            onChange={(e) =>
              set(i, {
                kind: e.target.value as ComponentRow['kind'],
                weight: { ...r.weight, unit: e.target.value === 'metal' ? 'g' : r.weight.unit },
              })
            }
            options={KINDS}
          />
          <TextField
            label="Description"
            value={r.description}
            disabled={disabled}
            onChange={(e) => set(i, { description: e.target.value })}
          />
          <TextField
            label="Count"
            inputMode="numeric"
            value={r.count}
            disabled={disabled}
            error={errors[`${prefix}.${i}.count`]}
            onChange={(e) => set(i, { count: e.target.value })}
          />
          <WeightField
            label="Total weight"
            value={r.weight}
            disabled={disabled}
            allowCarat={r.kind !== 'metal'}
            error={weightError(errors, `${prefix}.${i}.weight`)}
            onChange={(w) => set(i, { weight: w })}
          />
          {r.kind === 'metal' && (
            <SelectField
              label="Purity"
              value={r.purityId}
              disabled={disabled}
              error={errors[`${prefix}.${i}.purityId`]}
              onChange={(e) => set(i, { purityId: e.target.value })}
              options={[
                { value: '', label: 'Choose…' },
                ...purities
                  .filter((p) => p.status === 'active')
                  .map((p) => ({ value: p.id, label: p.label })),
              ]}
            />
          )}
          {!disabled && (
            <Button size="sm" variant="ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              Remove<span className="uc-sr-only"> component {i + 1}</span>
            </Button>
          )}
        </div>
      ))}
      {!disabled && rows.length < 50 && (
        <Button
          size="sm"
          style={{ alignSelf: 'flex-start' }}
          onClick={() =>
            onChange([
              ...rows,
              {
                kind: 'diamond',
                description: '',
                count: '1',
                weight: { value: '', unit: 'ct' },
                purityId: '',
              },
            ])
          }
        >
          Add component
        </Button>
      )}
    </fieldset>
  );
}
