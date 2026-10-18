import Decimal from 'decimal.js';

/**
 * Exact jewellery measurement arithmetic (specs/04). All values are decimal strings; nothing here ever uses JS
 * floating point. Canonical unit is the gram with 6 decimal places (NUMERIC(20,6) in the database).
 */
const D = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP });

export const WEIGHT_SCALE = 6;
export const WEIGHT_UNITS = ['g', 'mg', 'kg', 'ct'] as const;
export type WeightUnit = (typeof WEIGHT_UNITS)[number];

/** Exact unit factors to grams. 1 metric carat = 200 mg exactly (international definition). */
const TO_GRAMS: Record<WeightUnit, string> = { g: '1', mg: '0.001', kg: '1000', ct: '0.2' };

export class MeasurementError extends Error {}

const DECIMAL_RE = /^\d{1,14}(\.\d{1,6})?$/;

/** Converts a non-negative decimal string in `unit` to canonical grams (fixed 6 dp). Rejects precision loss. */
export function toGrams(value: string, unit: WeightUnit): string {
  if (!DECIMAL_RE.test(value)) throw new MeasurementError(`"${value}" is not a non-negative decimal with up to 6 decimals`);
  const grams = new D(value).times(TO_GRAMS[unit]);
  if (grams.decimalPlaces() > WEIGHT_SCALE) {
    throw new MeasurementError(`${value} ${unit} is more precise than 0.000001 g`);
  }
  if (grams.greaterThanOrEqualTo('1e14')) throw new MeasurementError(`${value} ${unit} is too large`);
  return grams.toFixed(WEIGHT_SCALE);
}

/** Grams → carats (exact; carats are only meaningful for stones). */
export function gramsToCarats(grams: string): string {
  return new D(grams).dividedBy(TO_GRAMS.ct).toFixed(WEIGHT_SCALE);
}

export function sumGrams(values: readonly string[]): string {
  return values.reduce((acc, v) => acc.plus(v), new D(0)).toFixed(WEIGHT_SCALE);
}

/** grams × fineness, rounded half-up to `scale` decimals, returned as a 6-dp string. */
export function fineWeight(grams: string, fineness: string, scale: number): string {
  return new D(grams).times(fineness).toDecimalPlaces(scale, Decimal.ROUND_HALF_UP).toFixed(WEIGHT_SCALE);
}

/**
 * Fine weight with provenance: Σ(metal component grams × fineness) when metal components exist (multi-metal
 * pieces), otherwise net × item fineness. Rounding happens once, on the total.
 */
export function computeFine(
  input: { netG: string; fineness: string; metalComponents?: { weightG: string; fineness: string }[] },
  scale: number,
): { fineG: string; formula: { id: string; scale: number; inputs: Record<string, unknown> } } {
  if (input.metalComponents && input.metalComponents.length > 0) {
    const exact = input.metalComponents.reduce((acc, c) => acc.plus(new D(c.weightG).times(c.fineness)), new D(0));
    return {
      fineG: exact.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP).toFixed(WEIGHT_SCALE),
      formula: { id: 'metal_components_x_fineness_v1', scale, inputs: { components: input.metalComponents } },
    };
  }
  return {
    fineG: fineWeight(input.netG, input.fineness, scale),
    formula: { id: 'net_x_fineness_v1', scale, inputs: { netG: input.netG, fineness: input.fineness } },
  };
}

export function compareGrams(a: string, b: string): -1 | 0 | 1 {
  return new D(a).comparedTo(b) as -1 | 0 | 1;
}

export function absDiff(a: string, b: string): string {
  return new D(a).minus(b).abs().toFixed(WEIGHT_SCALE);
}

export function withinTolerance(a: string, b: string, tolerance: string): boolean {
  return new D(a).minus(b).abs().lessThanOrEqualTo(tolerance);
}

/** Display helper: trims to `dp` decimals without rounding surprises (half-up). */
export function formatGrams(grams: string | null | undefined, dp = 3): string {
  if (grams === null || grams === undefined || grams === '') return '—';
  return `${new D(grams).toFixed(dp)} g`;
}

export const STONE_KINDS = ['diamond', 'gemstone', 'pearl'] as const;

/** Platform default purities. Starting points only — each merchant confirms fineness with their assayer/standard. */
export const DEFAULT_PURITIES = [
  { metal: 'gold', code: '24K', label: '24K (999)', fineness: '0.999000' },
  { metal: 'gold', code: '22K', label: '22K (916)', fineness: '0.916000' },
  { metal: 'gold', code: '18K', label: '18K (750)', fineness: '0.750000' },
  { metal: 'gold', code: '14K', label: '14K (585)', fineness: '0.585000' },
  { metal: 'silver', code: '999', label: 'Fine silver (999)', fineness: '0.999000' },
  { metal: 'silver', code: '925', label: 'Sterling silver (925)', fineness: '0.925000' },
  { metal: 'platinum', code: '950', label: 'Platinum (950)', fineness: '0.950000' },
] as const;
