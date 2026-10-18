import Decimal from 'decimal.js';

/**
 * Exact stock quantity arithmetic (Phase 04). Quantities are decimal strings with up to 6 decimals, stored as
 * NUMERIC(20,6). Piece-counted stock must be whole; gram-counted stock may be fractional. Never JS floats.
 */
const D = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP });

export const QTY_SCALE = 6;
export const STOCK_UNITS = ['pcs', 'g'] as const;
export type StockUnit = (typeof STOCK_UNITS)[number];

const QTY_RE = /^-?\d{1,14}(\.\d{1,6})?$/;

export class QuantityError extends Error {}

function d(value: string): Decimal {
  if (!QTY_RE.test(value)) throw new QuantityError(`"${value}" is not a decimal quantity with up to 6 decimals`);
  return new D(value);
}

/** Canonical 6-dp representation (also used to compare with NUMERIC(20,6) values read from the database). */
export function qty(value: string): string {
  return d(value).toFixed(QTY_SCALE);
}

export function qtyAdd(...values: readonly string[]): string {
  return values.reduce((acc, v) => acc.plus(d(v)), new D(0)).toFixed(QTY_SCALE);
}

export function qtySub(a: string, b: string): string {
  return d(a).minus(d(b)).toFixed(QTY_SCALE);
}

export function qtyNeg(a: string): string {
  return d(a).negated().toFixed(QTY_SCALE);
}

export function qtyCmp(a: string, b: string): -1 | 0 | 1 {
  return d(a).comparedTo(d(b)) as -1 | 0 | 1;
}

export function qtyMax0(a: string): string {
  const v = d(a);
  return (v.isNegative() ? new D(0) : v).toFixed(QTY_SCALE);
}

export function qtyIsZero(a: string): boolean {
  return d(a).isZero();
}

export function qtyIsWhole(a: string): boolean {
  return d(a).isInteger();
}

/** Checks a quantity is valid for a unit: positive (or non-zero when `signed`), and whole for pieces. */
export function qtyProblem(value: string, unit: StockUnit, options: { signed?: boolean; allowZero?: boolean } = {}):
  | string
  | null {
  if (!QTY_RE.test(value)) return 'Use a number with up to 6 decimals';
  const v = new D(value);
  if (!options.signed && v.isNegative()) return 'Quantity cannot be negative';
  if (!options.allowZero && v.isZero()) return 'Quantity cannot be zero';
  if (unit === 'pcs' && !v.isInteger()) return 'Piece quantities must be whole numbers';
  return null;
}

/** Display form: whole pieces without decimals; grams with at least 3 decimals. */
export function formatQty(value: string | null | undefined, unit: StockUnit = 'pcs'): string {
  if (value === null || value === undefined || value === '') return '—';
  const v = d(value);
  if (unit === 'pcs' && v.isInteger()) return v.toFixed(0);
  const fixed = v.toFixed(QTY_SCALE).replace(/0+$/, '');
  const [whole, frac = ''] = fixed.split('.');
  return `${whole}.${frac.padEnd(3, '0')}`;
}
