import Decimal from 'decimal.js';
import type { Metal } from './dto/jewellery';
import type {
  ComponentGroup,
  PriceBreakdown,
  PriceComponent,
  RateUnit,
  RuleConditions,
  RuleDefinition,
  WeightBasis,
} from './dto/pricing';

/**
 * Pure, deterministic price calculation (specs/04 "Pricing DSL"). No I/O, no JS floating point.
 *
 * Rounding policy (ADR-021): every component is computed exactly for the whole line (per-piece value × quantity)
 * and rounded ONCE to currency minor units, half-up. A discount is allocated across its eligible components by
 * largest remainder. Tax = round_half_up(Σ taxable × rate) once. Total = Σ components − discount + tax, so the
 * breakdown always adds up exactly to the total.
 */
const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
type Dec = InstanceType<typeof D>;

export class PricingError extends Error {
  constructor(
    readonly code: 'PRICE_INPUT_INVALID' | 'RATE_MISSING' | 'RATE_STALE',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Currency exponent from ISO 4217 data in the runtime (INR → 2, JPY → 0). */
export function currencyMinorUnits(currency: string): number {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

export function cmpDecimal(a: string, b: string): -1 | 0 | 1 {
  return new D(a).comparedTo(b) as -1 | 0 | 1;
}

const RATE_FACTOR: Record<RateUnit, string> = { per_g: '1', per_10g: '10', per_kg: '1000' };
const RATE_SCALE = 6;

/** Converts a quoted rate to the canonical rate per gram (6 dp). Rejects values that would lose precision. */
export function ratePerGram(value: string, unit: RateUnit): string {
  if (!/^\d{1,14}(\.\d{1,6})?$/.test(value)) throw new PricingError('PRICE_INPUT_INVALID', `"${value}" is not a rate`);
  const perG = new D(value).dividedBy(RATE_FACTOR[unit]);
  if (perG.decimalPlaces() > RATE_SCALE)
    throw new PricingError(
      'PRICE_INPUT_INVALID',
      `${value} ${unit.replace('_', ' ')} is more precise than 0.000001 per gram; enter it per gram instead`,
    );
  if (perG.isZero()) throw new PricingError('PRICE_INPUT_INVALID', 'A rate must be greater than zero');
  return perG.toFixed(RATE_SCALE);
}

/** Major-unit decimal → integer minor units (half-up), as a string. */
export function toMinor(major: Dec | string, minorUnits: number): string {
  return new D(major).times(new D(10).pow(minorUnits)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
}

/** Integer minor units → fixed major-unit string for display ("12345" INR → "123.45"). */
export function formatMinor(amountMinor: string, minorUnits: number): string {
  return new D(amountMinor).dividedBy(new D(10).pow(minorUnits)).toFixed(minorUnits);
}

export function sumMinor(values: readonly string[]): string {
  return values.reduce((acc, v) => acc.plus(v), new D(0)).toFixed(0);
}

// ---------------------------------------------------------------- inputs

export interface PricingStone {
  kind: 'diamond' | 'gemstone' | 'pearl' | 'other';
  grade: string | null;
  count: number;
  /** Total weight of this stone row in grams. */
  weightG: string;
}

export interface PricingItem {
  productType: 'standard' | 'jewellery';
  categoryId: string | null;
  metal: Metal | null;
  purityId: string | null;
  grossG: string | null;
  netG: string | null;
  fineG: string | null;
  /** The design/piece billing basis (used when a rule says weightBasis "item"). */
  billingBasis: 'gross' | 'net' | 'fine' | 'piece' | null;
  stones: PricingStone[];
  /** Whole pieces on this line. */
  quantity: number;
}

export interface PricingRate {
  id: string;
  ratePerG: string;
  currency: string;
  stale: boolean;
}

export interface PricingTax {
  id: string;
  label: string;
  ratePercent: string;
  appliesTo: ComponentGroup[];
  status: 'pending_validation' | 'validated' | 'inactive';
}

export interface PricingContext {
  currency: string;
  rate: PricingRate | null;
  /** List price per piece in major units (price book entry). */
  listPrice: string | null;
  tax: PricingTax | null;
  /**
   * Phase 10: order promotions already allocated to this line (integer minor units). They are spread over the
   * line's components after the rule discount and BEFORE tax, so tax is computed on the discounted amounts.
   */
  promotions?: { id: string; label: string; discountMinor: string }[];
}

/** A promotion to plan across an order (Phase 10). `value` is a percentage or major-unit amount. */
export interface PromotionInput {
  id: string;
  label: string;
  mode: 'percent' | 'fixed';
  value: string;
}

/**
 * Splits order-level promotions over lines, exactly. Each promotion's amount is computed on the order base (sum of
 * line amounts after rule discounts): percent → half-up of base × value / 100; fixed → min(value, base). Promotions
 * together never exceed the base. Each amount is allocated across lines by largest remainder, weighted by line base.
 * Returns, per line, the promotions with their minor share.
 */
export function planPromotions(
  lineBasesMinor: readonly string[],
  promotions: readonly PromotionInput[],
  minorUnits: number,
): { perLine: { id: string; label: string; discountMinor: string }[][]; totals: { id: string; discountMinor: string }[] } {
  const base = new D(sumMinor(lineBasesMinor));
  let left = base;
  const perLine: { id: string; label: string; discountMinor: string }[][] = lineBasesMinor.map(() => []);
  const totals: { id: string; discountMinor: string }[] = [];
  for (const p of promotions) {
    const wanted = p.mode === 'percent' ? new D(toMinor(base.times(p.value).dividedBy(100), 0)) : new D(toMinor(p.value, minorUnits));
    const amount = D.min(wanted, left);
    left = left.minus(amount);
    totals.push({ id: p.id, discountMinor: amount.toFixed(0) });
    if (amount.isZero()) continue;
    allocate(amount.toFixed(0), lineBasesMinor).forEach((share, i) => {
      if (share !== '0') perLine[i]!.push({ id: p.id, label: p.label, discountMinor: share });
    });
  }
  return { perLine, totals };
}

// ---------------------------------------------------------------- conditions

/** A rule applies when every non-empty condition list contains the item's value. */
export function ruleMatches(c: RuleConditions, item: Pick<PricingItem, 'productType' | 'categoryId' | 'metal' | 'purityId'>): boolean {
  const ok = <T>(list: readonly T[], value: T | null) => list.length === 0 || (value !== null && list.includes(value));
  return ok(c.productTypes, item.productType) && ok(c.categoryIds, item.categoryId) && ok(c.metals, item.metal) && ok(c.purityIds, item.purityId);
}

/** Two condition sets can match the same item (empty list = any value). Used for publish-time conflict detection. */
export function conditionsOverlap(a: RuleConditions, b: RuleConditions): boolean {
  const meet = <T>(x: readonly T[], y: readonly T[]) => x.length === 0 || y.length === 0 || x.some((v) => y.includes(v));
  return meet(a.productTypes, b.productTypes) && meet(a.categoryIds, b.categoryIds) && meet(a.metals, b.metals) && meet(a.purityIds, b.purityIds);
}

// ---------------------------------------------------------------- calculation

const fmt = (d: Dec, dp = 6) => d.toFixed(dp);
const CARAT_G = '0.2';

interface Draft {
  code: string;
  group: ComponentGroup;
  label: string;
  formula: string;
  inputs: Record<string, string>;
  exact: Dec;
}

function billableWeight(item: PricingItem, basis: WeightBasis): { basis: 'gross' | 'net' | 'fine'; grams: Dec } {
  const resolved = basis === 'item' ? item.billingBasis : basis;
  if (resolved === null)
    throw new PricingError('PRICE_INPUT_INVALID', 'The item has no billing basis; the rule must name gross, net or fine', { field: 'billingBasis' });
  if (resolved === 'piece')
    throw new PricingError('PRICE_INPUT_INVALID', 'The item is billed per piece, so it has no billable metal weight; price it with a list-price rule', {
      field: 'billingBasis',
    });
  const grams = resolved === 'gross' ? item.grossG : resolved === 'net' ? item.netG : item.fineG;
  if (grams === null)
    throw new PricingError('PRICE_INPUT_INVALID', `The item has no ${resolved} weight recorded`, { field: `${resolved}G` });
  return { basis: resolved, grams: new D(grams) };
}

function requireRate(ctx: PricingContext): PricingRate {
  if (!ctx.rate) throw new PricingError('RATE_MISSING', 'No approved metal rate for this metal and purity');
  if (ctx.rate.currency !== ctx.currency)
    throw new PricingError('PRICE_INPUT_INVALID', `The metal rate is in ${ctx.rate.currency} but the price book is in ${ctx.currency}`);
  return ctx.rate;
}

/** Largest-remainder allocation of `total` minor units across `weights` (all integers ≥ 0). */
export function allocate(total: string, weights: readonly string[]): string[] {
  const sum = weights.reduce((a, w) => a.plus(w), new D(0));
  if (sum.isZero()) return weights.map(() => '0');
  const exact = weights.map((w) => new D(total).times(w).dividedBy(sum));
  const floors = exact.map((e) => e.floor());
  let rest = new D(total).minus(floors.reduce((a, f) => a.plus(f), new D(0)));
  const order = exact.map((e, i) => ({ i, frac: e.minus(e.floor()) })).sort((x, y) => y.frac.comparedTo(x.frac) || x.i - y.i);
  const out = floors.map((f) => f);
  for (const { i } of order) {
    if (rest.lte(0)) break;
    out[i] = out[i]!.plus(1);
    rest = rest.minus(1);
  }
  return out.map((o) => o.toFixed(0));
}

/** Prices one line. Throws PricingError for missing inputs; never guesses. */
export function calculatePrice(rule: RuleDefinition, item: PricingItem, ctx: PricingContext): PriceBreakdown {
  if (!Number.isInteger(item.quantity) || item.quantity < 1)
    throw new PricingError('PRICE_INPUT_INVALID', 'Quantity must be a whole number of pieces');
  const mu = currencyMinorUnits(ctx.currency);
  const qty = new D(item.quantity);
  const parts: Draft[] = [];
  const warnings: string[] = [];
  let metalExact: Dec | null = null;
  let metalWeight: { basis: string; grams: Dec } | null = null;

  if (rule.base.kind === 'metal') {
    const rate = requireRate(ctx);
    metalWeight = billableWeight(item, rule.base.weightBasis);
    metalExact = metalWeight.grams.times(rate.ratePerG).times(qty);
    parts.push({
      code: 'metal',
      group: 'metal',
      label: `Metal value (${metalWeight.basis} weight)`,
      formula: `${fmt(metalWeight.grams)} g × ${rate.ratePerG} /g × ${item.quantity}`,
      inputs: { weightG: fmt(metalWeight.grams), basis: metalWeight.basis, ratePerG: rate.ratePerG, rateId: rate.id, quantity: String(item.quantity) },
      exact: metalExact,
    });
    if (rate.stale) warnings.push('The metal rate is older than the maximum rate age (stale rate used under the fallback policy)');
  } else {
    if (ctx.listPrice === null) throw new PricingError('PRICE_INPUT_INVALID', 'No list price for this item in the price book', { field: 'listPrice' });
    parts.push({
      code: 'list_price',
      group: 'list_price',
      label: 'List price',
      formula: `${ctx.listPrice} × ${item.quantity}`,
      inputs: { unitPrice: ctx.listPrice, quantity: String(item.quantity) },
      exact: new D(ctx.listPrice).times(qty),
    });
  }

  const weightFor = (basis: WeightBasis | undefined) => {
    if (basis) return billableWeight(item, basis);
    if (metalWeight) return metalWeight as { basis: 'gross' | 'net' | 'fine'; grams: Dec };
    return billableWeight(item, 'item');
  };

  // Making
  const m = rule.making;
  if (m.mode === 'per_gram') {
    const w = weightFor(m.weightBasis);
    parts.push({
      code: 'making',
      group: 'making',
      label: `Making charge per gram (${w.basis})`,
      formula: `${fmt(w.grams)} g × ${m.amount} /g × ${item.quantity}`,
      inputs: { weightG: fmt(w.grams), basis: w.basis, perGram: m.amount, quantity: String(item.quantity) },
      exact: w.grams.times(m.amount).times(qty),
    });
  } else if (m.mode === 'tiered_per_gram') {
    const w = weightFor(m.weightBasis);
    const tier = m.tiers.find((t) => t.upToG === null || w.grams.lte(t.upToG))!;
    parts.push({
      code: 'making',
      group: 'making',
      label: `Making charge per gram, tier ${tier.upToG === null ? 'above last limit' : `up to ${tier.upToG} g`} (${w.basis})`,
      formula: `${fmt(w.grams)} g × ${tier.amount} /g × ${item.quantity}`,
      inputs: { weightG: fmt(w.grams), basis: w.basis, perGram: tier.amount, tierUpToG: tier.upToG ?? 'open', quantity: String(item.quantity) },
      exact: w.grams.times(tier.amount).times(qty),
    });
  } else if (m.mode === 'per_piece') {
    parts.push({
      code: 'making',
      group: 'making',
      label: 'Making charge per piece',
      formula: `${m.amount} × ${item.quantity}`,
      inputs: { perPiece: m.amount, quantity: String(item.quantity) },
      exact: new D(m.amount).times(qty),
    });
  } else if (m.mode === 'percent_of_metal') {
    if (!metalExact) throw new PricingError('PRICE_INPUT_INVALID', 'Making as % of metal needs a metal-value base');
    parts.push({
      code: 'making',
      group: 'making',
      label: `Making charge ${m.percent}% of metal value`,
      formula: `${fmt(metalExact)} × ${m.percent}%`,
      inputs: { metalValue: fmt(metalExact), percent: m.percent },
      exact: metalExact.times(m.percent).dividedBy(100),
    });
  } else if (m.mode === 'per_line') {
    parts.push({
      code: 'making',
      group: 'making',
      label: 'Making charge (per line)',
      formula: `${m.amount}`,
      inputs: { perLine: m.amount },
      exact: new D(m.amount),
    });
  }

  // Wastage: explicit added weight valued at the same rate, shown separately (never folded into the metal line).
  if (rule.wastage) {
    const rate = requireRate(ctx);
    const w = weightFor(rule.wastage.weightBasis);
    const extra = w.grams.times(rule.wastage.percent).dividedBy(100);
    parts.push({
      code: 'wastage',
      group: 'wastage',
      label: `Wastage ${rule.wastage.percent}% of ${w.basis} weight`,
      formula: `${fmt(w.grams)} g × ${rule.wastage.percent}% = ${fmt(extra)} g × ${rate.ratePerG} /g × ${item.quantity}`,
      inputs: { weightG: fmt(w.grams), basis: w.basis, percent: rule.wastage.percent, addedG: fmt(extra), ratePerG: rate.ratePerG, quantity: String(item.quantity) },
      exact: extra.times(rate.ratePerG).times(qty),
    });
  }

  // Stones: each recorded stone row is its own line item.
  if (item.stones.length > 0) {
    if (!rule.stones) {
      warnings.push('Stones are recorded on this item but the rule has no stone pricing (stones not charged)');
    } else {
      item.stones.forEach((s, i) => {
        const grade = s.grade?.toLowerCase() ?? null;
        const match =
          rule.stones!.rates.find((r) => r.kind === s.kind && r.grade !== null && r.grade.toLowerCase() === grade) ??
          rule.stones!.rates.find((r) => r.kind === s.kind && r.grade === null);
        if (!match)
          throw new PricingError('PRICE_INPUT_INVALID', `No stone rate for ${s.kind}${s.grade ? ` grade ${s.grade}` : ''}`, {
            field: `stones.${i}`,
            kind: s.kind,
            grade: s.grade,
          });
        const carats = new D(s.weightG).dividedBy(CARAT_G);
        const label = `${s.kind}${s.grade ? ` ${s.grade}` : ''} (${s.count} pcs, ${fmt(carats, 3)} ct)`;
        if (rule.stones!.mode === 'per_carat') {
          parts.push({
            code: `stone_${i + 1}`,
            group: 'stones',
            label: `Stones: ${label}`,
            formula: `${fmt(carats)} ct × ${match.amount} /ct × ${item.quantity}`,
            inputs: { carats: fmt(carats), perCarat: match.amount, quantity: String(item.quantity) },
            exact: carats.times(match.amount).times(qty),
          });
        } else {
          parts.push({
            code: `stone_${i + 1}`,
            group: 'stones',
            label: `Stones: ${label}`,
            formula: `${s.count} pcs × ${match.amount} /pc × ${item.quantity}`,
            inputs: { count: String(s.count), perStone: match.amount, quantity: String(item.quantity) },
            exact: new D(s.count).times(match.amount).times(qty),
          });
        }
      });
    }
  }

  // Other charges
  rule.charges.forEach((c, i) => {
    let exact: Dec;
    let formula: string;
    const inputs: Record<string, string> = { amount: c.amount, mode: c.mode };
    if (c.mode === 'per_piece') {
      exact = new D(c.amount).times(qty);
      formula = `${c.amount} × ${item.quantity}`;
    } else if (c.mode === 'per_gram') {
      const w = weightFor(undefined);
      exact = w.grams.times(c.amount).times(qty);
      formula = `${fmt(w.grams)} g × ${c.amount} /g × ${item.quantity}`;
      inputs.weightG = fmt(w.grams);
    } else {
      exact = new D(c.amount);
      formula = `${c.amount}`;
    }
    parts.push({ code: `charge_${i + 1}_${c.code}`, group: 'charges', label: c.label, formula, inputs, exact });
  });

  // Round each component once.
  const components: PriceComponent[] = parts.map((p) => ({
    code: p.code,
    group: p.group,
    label: p.label,
    formula: p.formula,
    inputs: p.inputs,
    exact: p.exact.toFixed(Math.max(mu, 6)),
    amountMinor: toMinor(p.exact, mu),
    discountMinor: '0',
    taxableMinor: '0',
  }));

  // Discount, allocated across eligible components.
  let discountTotal = '0';
  if (rule.discount) {
    const eligible = components.filter((c) => rule.discount!.appliesTo.includes(c.group));
    const base = sumMinor(eligible.map((c) => c.amountMinor));
    discountTotal =
      rule.discount.mode === 'percent'
        ? toMinor(new D(base).times(rule.discount.value).dividedBy(100), 0)
        : D.min(new D(toMinor(rule.discount.value, mu)), new D(base)).toFixed(0);
    const shares = allocate(
      discountTotal,
      eligible.map((c) => c.amountMinor),
    );
    eligible.forEach((c, i) => (c.discountMinor = shares[i]!));
    if (rule.discount.mode === 'fixed' && new D(toMinor(rule.discount.value, mu)).gt(base))
      warnings.push('The fixed discount was larger than the eligible amount and was capped');
  }

  // Order promotions (already split per line): spread over what is left of each component, before tax.
  const promotions: NonNullable<PriceBreakdown['promotions']> = [];
  for (const promo of ctx.promotions ?? []) {
    const remaining = components.map((c) => new D(c.amountMinor).minus(c.discountMinor).toFixed(0));
    const applied = D.min(new D(promo.discountMinor), new D(sumMinor(remaining))).toFixed(0);
    allocate(applied, remaining).forEach((share, i) => {
      components[i]!.discountMinor = new D(components[i]!.discountMinor).plus(share).toFixed(0);
    });
    discountTotal = new D(discountTotal).plus(applied).toFixed(0);
    promotions.push({ id: promo.id, label: promo.label, discountMinor: applied });
  }

  // Tax hook.
  let tax: PriceBreakdown['tax'] = null;
  let taxMinor = '0';
  if (ctx.tax && ctx.tax.status !== 'inactive') {
    const t = ctx.tax;
    let base = new D(0);
    for (const c of components) {
      if (t.appliesTo.includes(c.group)) {
        c.taxableMinor = new D(c.amountMinor).minus(c.discountMinor).toFixed(0);
        base = base.plus(c.taxableMinor);
      }
    }
    const exact = base.times(t.ratePercent).dividedBy(100);
    taxMinor = exact.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
    tax = { ruleId: t.id, label: t.label, ratePercent: t.ratePercent, status: t.status, baseMinor: base.toFixed(0), exact: exact.toFixed(6) };
    if (t.status === 'pending_validation') warnings.push(`Tax "${t.label}" is merchant-entered and pending accountant validation`);
  }

  const subtotalMinor = sumMinor(components.map((c) => c.amountMinor));
  const totalMinor = new D(subtotalMinor).minus(discountTotal).plus(taxMinor).toFixed(0);
  return {
    currency: ctx.currency,
    minorUnits: mu,
    rounding: 'component_half_up',
    components,
    subtotalMinor,
    discountMinor: discountTotal,
    ...(promotions.length ? { promotions } : {}),
    tax,
    taxMinor,
    totalMinor,
    warnings,
  };
}
