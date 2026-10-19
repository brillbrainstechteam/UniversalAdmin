import {
  MeasurementError,
  qtyProblem,
  toGrams,
  type CanonicalRecord,
  type MappingRule,
  type MappingTarget,
} from '@uc/contracts';

export interface FieldError {
  field: string;
  message: string;
}

export interface MappingResult {
  record: CanonicalRecord | null;
  errors: FieldError[];
}

export interface MappingDefaults {
  productType?: 'standard' | 'jewellery';
  location?: string | null;
}

const UNIT_ALIASES: Record<string, 'pcs' | 'g'> = {
  pcs: 'pcs',
  pc: 'pcs',
  piece: 'pcs',
  pieces: 'pcs',
  nos: 'pcs',
  no: 'pcs',
  qty: 'pcs',
  g: 'g',
  gm: 'g',
  gms: 'g',
  gram: 'g',
  grams: 'g',
};
const TRUE = new Set(['yes', 'y', 'true', '1', 'deleted', 'sold', 'inactive', 'removed']);
const FALSE = new Set(['', 'no', 'n', 'false', '0', 'active', 'in stock', 'instock', 'available']);

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Looks a column up exactly, then case/space-insensitively (spreadsheet headers vary). */
function column(raw: Record<string, unknown>, name: string): unknown {
  if (name in raw) return raw[name];
  const wanted = name.trim().toLowerCase();
  const key = Object.keys(raw).find((k) => k.trim().toLowerCase() === wanted);
  return key === undefined ? undefined : raw[key];
}

/** Parses "2026-01-31", "2026-01-31 14:05", "2026-01-31T14:05:00Z"; returns ISO or null when invalid. */
export function parseTimestamp(value: string): string | null {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
      value.trim(),
    );
  if (!m) return null;
  // Reject impossible calendar values instead of letting Date roll them over (2026-02-30 → 2 March).
  const [y, mo, d, h = '00', mi = '00', s = '00'] = [m[1]!, m[2]!, m[3]!, m[4], m[5], m[6]];
  const day = new Date(Date.UTC(+y, +mo - 1, +d));
  if (day.getUTCFullYear() !== +y || day.getUTCMonth() !== +mo - 1 || day.getUTCDate() !== +d) return null;
  if (+h > 23 || +mi > 59 || +s > 59) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? '00'}:${m[5] ?? '00'}:${m[6] ?? '00'}${m[7] ?? 'Z'}`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Applies a mapping to one source record. Exact decimal conversion of weights to grams; every problem is reported
 * per field so the row can be shown (and exported) with its errors instead of being dropped.
 */
export function applyMapping(
  rules: readonly MappingRule[],
  raw: Record<string, unknown>,
  defaults: MappingDefaults = {},
): MappingResult {
  const errors: FieldError[] = [];
  const byTarget = new Map<MappingTarget, MappingRule>();
  for (const r of rules) byTarget.set(r.target, r);

  const get = (target: MappingTarget): string => {
    const rule = byTarget.get(target);
    if (!rule) return '';
    let v = rule.constant !== undefined ? rule.constant : cell(column(raw, rule.source!));
    if (rule.transform !== 'none') v = v.trim();
    if (rule.transform === 'upper') v = v.toUpperCase();
    if (rule.transform === 'lower') v = v.toLowerCase();
    return v;
  };
  const grams = (target: 'grossWeight' | 'netWeight' | 'stoneWeight'): string | null => {
    const v = get(target);
    if (v === '') return null;
    const unit = byTarget.get(target)?.weightUnit ?? 'g';
    if (unit === 'ct' && target !== 'stoneWeight') {
      errors.push({ field: target, message: 'Carats are only valid for stone weight' });
      return null;
    }
    try {
      return toGrams(v, unit);
    } catch (e) {
      errors.push({
        field: target,
        message: e instanceof MeasurementError ? `"${v}" ${unit}: ${e.message}` : `"${v}" is not a weight`,
      });
      return null;
    }
  };

  const externalId = get('externalId');
  if (!externalId) errors.push({ field: 'externalId', message: 'External ID is required' });
  else if (externalId.length > 120)
    errors.push({ field: 'externalId', message: 'External ID is longer than 120 characters' });

  const sku = get('sku');
  if (!sku) errors.push({ field: 'sku', message: 'SKU / design code is required' });
  else if (sku.length > 80) errors.push({ field: 'sku', message: 'SKU is longer than 80 characters' });

  const tag = get('tag') || null;
  const typeText = get('recordType').toLowerCase();
  let recordType: 'design' | 'piece' = tag ? 'piece' : 'design';
  if (typeText) {
    if (['design', 'item', 'sku', 'style'].includes(typeText)) recordType = 'design';
    else if (['piece', 'tag', 'serial'].includes(typeText)) recordType = 'piece';
    else
      errors.push({
        field: 'recordType',
        message: `Unknown record type "${typeText}" (use design or piece)`,
      });
  }

  const ptText = get('productType').toLowerCase();
  let productType = defaults.productType ?? 'standard';
  if (ptText) {
    if (ptText === 'standard' || ptText === 'jewellery' || ptText === 'jewelry') {
      productType = ptText === 'standard' ? 'standard' : 'jewellery';
    } else errors.push({ field: 'productType', message: `Unknown product type "${ptText}"` });
  }

  const unitText = get('unit').toLowerCase();
  let unit: 'pcs' | 'g' = 'pcs';
  if (unitText) {
    const u = UNIT_ALIASES[unitText];
    if (u) unit = u;
    else errors.push({ field: 'unit', message: `Unknown unit "${unitText}" (use pcs or g)` });
  }

  const qtyText = get('quantity');
  let quantity: string | null = null;
  if (qtyText !== '') {
    const problem = qtyProblem(qtyText, unit, { allowZero: true });
    if (problem) errors.push({ field: 'quantity', message: `"${qtyText}": ${problem}` });
    else quantity = qtyText;
  }

  const grossG = grams('grossWeight');
  const netG = grams('netWeight');
  const stoneG = grams('stoneWeight');
  const purity = get('purity').toUpperCase() || null;
  const huid = get('huid').toUpperCase() || null;

  if (recordType === 'piece') {
    if (!tag) errors.push({ field: 'tag', message: 'A piece needs its tag / serial number' });
    if (productType !== 'jewellery') productType = 'jewellery';
    if (!purity) errors.push({ field: 'purity', message: 'A piece needs a purity code' });
    if (!get('grossWeight')) errors.push({ field: 'grossWeight', message: 'A piece needs its gross weight' });
    if (!get('netWeight')) errors.push({ field: 'netWeight', message: 'A piece needs its net weight' });
  }

  const updatedText = get('updatedAt');
  let updatedAt: string | null = null;
  if (updatedText) {
    updatedAt = parseTimestamp(updatedText);
    if (!updatedAt)
      errors.push({
        field: 'updatedAt',
        message: `"${updatedText}" is not a date/time (use YYYY-MM-DD HH:MM)`,
      });
  }

  const version = get('version') || null;
  if (version && version.length > 40)
    errors.push({ field: 'version', message: 'Version is longer than 40 characters' });

  const deletedText = get('deleted').toLowerCase();
  let deleted = false;
  if (TRUE.has(deletedText)) deleted = true;
  else if (!FALSE.has(deletedText))
    errors.push({ field: 'deleted', message: `Unknown deleted/status value "${deletedText}"` });

  const location = get('location') || defaults.location || null;
  const title = get('title') || null;
  if (title && title.length > 200)
    errors.push({ field: 'title', message: 'Title is longer than 200 characters' });

  if (errors.length) return { record: null, errors };
  return {
    record: {
      externalId,
      recordType,
      sku,
      title,
      productType,
      purity,
      grossG,
      netG,
      stoneG,
      huid,
      tag,
      location,
      quantity,
      unit,
      version,
      updatedAt,
      deleted,
    },
    errors,
  };
}

/** Rules must name the required targets once each. Returns problems (empty = valid). */
export function validateRules(rules: readonly MappingRule[]): FieldError[] {
  const problems: FieldError[] = [];
  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.target)) problems.push({ field: r.target, message: `${r.target} is mapped twice` });
    seen.add(r.target);
    if (r.weightUnit && !['grossWeight', 'netWeight', 'stoneWeight'].includes(r.target)) {
      problems.push({ field: r.target, message: 'A weight unit only applies to weight fields' });
    }
  }
  for (const required of ['externalId', 'sku'] as const) {
    if (!seen.has(required)) problems.push({ field: required, message: `${required} must be mapped` });
  }
  return problems;
}

/** Stable JSON for checksums (sorted keys). */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
