'use client';

import { formatGrams, type MeasurementCheck, type WeightInput } from '@uc/contracts';
import { Alert, Badge } from '@uc/ui';
import { useId } from 'react';

export interface WeightState {
  value: string;
  unit: WeightInput['unit'];
}

export const emptyWeight = (unit: WeightInput['unit'] = 'g'): WeightState => ({ value: '', unit });
export const fromGrams = (g: string | null | undefined): WeightState => ({
  value: g ? trimZeros(g) : '',
  unit: 'g',
});
/** Raw input as stored by the API, falling back to canonical grams. */
export const fromRaw = (raw: unknown, grams: string | null | undefined): WeightState => {
  const r = raw as { value?: string; unit?: WeightInput['unit'] } | null | undefined;
  return r?.value ? { value: r.value, unit: r.unit ?? 'g' } : fromGrams(grams);
};
export const toInput = (w: WeightState): WeightInput | null =>
  w.value.trim() === '' ? null : { value: w.value.trim(), unit: w.unit };

export function trimZeros(decimal: string): string {
  return decimal.includes('.') ? decimal.replace(/0+$/, '').replace(/\.$/, '') : decimal;
}

/** Number + explicit unit. The value stays a string end to end (no float parsing in the browser). */
export function WeightField({
  label,
  value,
  onChange,
  error,
  disabled,
  allowCarat = false,
  hint,
}: {
  label: string;
  value: WeightState;
  onChange: (v: WeightState) => void;
  error?: string;
  disabled?: boolean;
  allowCarat?: boolean;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="uc-field">
      <label htmlFor={id}>{label}</label>
      <div className="uc-row" style={{ flexWrap: 'nowrap' }}>
        <input
          id={id}
          className="uc-input"
          inputMode="decimal"
          value={value.value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange({ ...value, value: e.target.value })}
        />
        <select
          className="uc-select"
          style={{ width: 80 }}
          aria-label={`${label} unit`}
          value={value.unit}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, unit: e.target.value as WeightState['unit'] })}
        >
          <option value="g">g</option>
          <option value="mg">mg</option>
          <option value="kg">kg</option>
          {allowCarat && <option value="ct">ct</option>}
        </select>
      </div>
      {hint && !error && <span className="uc-hint">{hint}</span>}
      {error && <span className="uc-error">{error}</span>}
    </div>
  );
}

export function Checks({ checks }: { checks: MeasurementCheck[] }) {
  if (checks.length === 0) return <Badge tone="success">Measurements consistent</Badge>;
  return (
    <div className="uc-stack" style={{ gap: 6 }}>
      {checks.map((c) => (
        <Alert key={c.code} tone={c.severity === 'warning' ? 'warning' : 'info'}>
          {c.message}
        </Alert>
      ))}
    </div>
  );
}

export const grams = (g: string | null | undefined) => formatGrams(g, 3);

/** Field errors from the API for nested weight inputs ("gross.value" → shown on "gross"). */
export function weightError(errors: Record<string, string>, key: string): string | undefined {
  return errors[`${key}.value`] ?? errors[`${key}.unit`] ?? errors[key];
}
