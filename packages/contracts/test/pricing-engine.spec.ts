import { describe, expect, it } from 'vitest';
import {
  PricingError,
  RuleConditions,
  RuleDefinition,
  allocate,
  calculatePrice,
  conditionsOverlap,
  currencyMinorUnits,
  formatMinor,
  ratePerGram,
  ruleMatches,
  type PricingContext,
  type PricingItem,
} from '../src';

/**
 * Fixture-based pricing tests (PR-01, PR-04, PR-05). Every expected amount below was computed by hand from the
 * documented rounding policy: components rounded once to minor units half-up, discount by largest remainder,
 * tax rounded once on the discounted base.
 */
const P22 = '00000000-0000-4000-8000-000000000022';
const item = (over: Partial<PricingItem> = {}): PricingItem => ({
  productType: 'jewellery',
  categoryId: null,
  metal: 'gold',
  purityId: P22,
  grossG: '10.250000',
  netG: '9.875000',
  fineG: '9.045500',
  billingBasis: 'net',
  stones: [],
  quantity: 1,
  ...over,
});
const ctx = (over: Partial<PricingContext> = {}): PricingContext => ({
  currency: 'INR',
  rate: { id: 'r1', ratePerG: '6250.500000', currency: 'INR', stale: false },
  listPrice: null,
  tax: null,
  ...over,
});
const rule = (r: unknown) => RuleDefinition.parse(r);
const amounts = (b: ReturnType<typeof calculatePrice>) => Object.fromEntries(b.components.map((c) => [c.code, c.amountMinor]));

describe('rate units (PR-01)', () => {
  it('converts per 10 g and per kg exactly to a rate per gram', () => {
    expect(ratePerGram('62505', 'per_10g')).toBe('6250.500000');
    expect(ratePerGram('6250500.5', 'per_kg')).toBe('6250.500500');
    expect(ratePerGram('6250.5', 'per_g')).toBe('6250.500000');
  });
  it('rejects values that would lose precision or are zero', () => {
    expect(() => ratePerGram('0.000001', 'per_kg')).toThrow(PricingError);
    expect(() => ratePerGram('6250.1234567', 'per_g')).toThrow(PricingError);
    expect(() => ratePerGram('0', 'per_g')).toThrow(/greater than zero/);
  });
  it('knows currency exponents', () => {
    expect(currencyMinorUnits('INR')).toBe(2);
    expect(currencyMinorUnits('JPY')).toBe(0);
    expect(formatMinor('6406763', 2)).toBe('64067.63');
  });
});

describe('gross vs net billing (PR-04)', () => {
  it('gross-based rule: metal and per-gram making on gross weight', () => {
    const b = calculatePrice(
      rule({ base: { kind: 'metal', weightBasis: 'gross' }, making: { mode: 'per_gram', amount: '450' } }),
      item(),
      ctx(),
    );
    // 10.25 × 6250.5 = 64067.625 → 6406762.5 → 6406763 ; 10.25 × 450 = 4612.50
    expect(amounts(b)).toEqual({ metal: '6406763', making: '461250' });
    expect(b.totalMinor).toBe('6868013');
  });
  it('net-based rule: same piece, different exact amount', () => {
    const b = calculatePrice(
      rule({ base: { kind: 'metal', weightBasis: 'net' }, making: { mode: 'per_gram', amount: '450' } }),
      item(),
      ctx(),
    );
    // 9.875 × 6250.5 = 61723.6875 → 6172369 ; 9.875 × 450 = 4443.75
    expect(amounts(b)).toEqual({ metal: '6172369', making: '444375' });
    expect(b.totalMinor).toBe('6616744');
    expect(b.components[0]!.exact).toBe('61723.687500');
  });
  it('"item" basis follows the design/piece billing basis', () => {
    const b = calculatePrice(rule({ base: { kind: 'metal', weightBasis: 'item' } }), item({ billingBasis: 'gross' }), ctx());
    expect(b.components[0]!.inputs.basis).toBe('gross');
  });
  it('no float drift: 1.005 g × 1.00 rounds half-up to 1.01, not 1.00', () => {
    const b = calculatePrice(
      rule({ base: { kind: 'metal', weightBasis: 'gross' } }),
      item({ grossG: '1.005000' }),
      ctx({ rate: { id: 'r', ratePerG: '1.000000', currency: 'INR', stale: false } }),
    );
    expect(b.totalMinor).toBe('101');
  });
  it('fails clearly instead of guessing', () => {
    expect(() => calculatePrice(rule({ base: { kind: 'metal', weightBasis: 'net' } }), item(), ctx({ rate: null }))).toThrow(/No approved metal rate/);
    expect(() => calculatePrice(rule({ base: { kind: 'metal', weightBasis: 'gross' } }), item({ grossG: null }), ctx())).toThrow(/no gross weight/);
    expect(() => calculatePrice(rule({ base: { kind: 'metal', weightBasis: 'item' } }), item({ billingBasis: 'piece' }), ctx())).toThrow(/billed per piece/);
    expect(() =>
      calculatePrice(rule({ base: { kind: 'metal', weightBasis: 'net' } }), item(), ctx({ rate: { id: 'r', ratePerG: '1', currency: 'USD', stale: false } })),
    ).toThrow(/USD/);
  });
});

describe('full breakdown (PR-05)', () => {
  const full = rule({
    base: { kind: 'metal', weightBasis: 'net' },
    making: { mode: 'tiered_per_gram', tiers: [{ upToG: '10', amount: '500' }, { upToG: null, amount: '400' }] },
    wastage: { percent: '2' },
    stones: {
      mode: 'per_carat',
      rates: [
        { kind: 'diamond', grade: 'VS', amount: '45000' },
        { kind: 'diamond', grade: null, amount: '30000' },
        { kind: 'gemstone', grade: null, amount: '8000' },
      ],
    },
    charges: [
      { code: 'hallmark', label: 'Hallmarking', mode: 'per_piece', amount: '45' },
      { code: 'certificate', label: 'Certificate', mode: 'per_line', amount: '250' },
    ],
    discount: { mode: 'percent', value: '10', appliesTo: ['making', 'wastage'] },
    taxRuleId: '00000000-0000-4000-8000-000000000001',
  });
  const piece = item({
    grossG: '12.500000',
    netG: '11.200000',
    quantity: 2,
    stones: [
      { kind: 'diamond', grade: 'vs', count: 3, weightG: '0.050000' },
      { kind: 'gemstone', grade: 'ruby AA', count: 1, weightG: '0.100000' },
    ],
  });
  const c = ctx({
    rate: { id: 'r1', ratePerG: '6000.000000', currency: 'INR', stale: false },
    tax: { id: 't1', label: 'Tax (example)', ratePercent: '3', appliesTo: ['metal', 'making', 'wastage', 'stones', 'charges'], status: 'pending_validation' },
  });

  it('computes every component exactly and the parts add up to the total', () => {
    const b = calculatePrice(full, piece, c);
    expect(amounts(b)).toEqual({
      metal: '13440000', // 11.2 × 6000 × 2
      making: '896000', // tier above 10 g: 11.2 × 400 × 2
      wastage: '268800', // 0.224 g × 6000 × 2
      stone_1: '2250000', // 0.25 ct × 45000 (grade match is case-insensitive) × 2
      stone_2: '800000', // 0.5 ct × 8000 (kind default) × 2
      charge_1_hallmark: '9000', // 45 × 2
      charge_2_certificate: '25000', // once per line
    });
    expect(b.subtotalMinor).toBe('17688800');
    expect(b.discountMinor).toBe('116480'); // 10% of 1164800
    expect(b.components.find((x) => x.code === 'making')!.discountMinor).toBe('89600');
    expect(b.components.find((x) => x.code === 'wastage')!.discountMinor).toBe('26880');
    expect(b.tax!.baseMinor).toBe('17572320');
    expect(b.taxMinor).toBe('527170'); // 527169.6 → half-up
    expect(b.totalMinor).toBe('18099490');
    expect(b.warnings.join(' ')).toMatch(/pending accountant validation/);
    const sum = b.components.reduce((a, x) => a + BigInt(x.amountMinor) - BigInt(x.discountMinor), 0n) + BigInt(b.taxMinor);
    expect(sum.toString()).toBe(b.totalMinor);
  });
  it('tier below the limit and per-piece stones', () => {
    const b = calculatePrice(
      rule({ ...full, making: { mode: 'tiered_per_gram', tiers: [{ upToG: '12', amount: '500' }, { upToG: null, amount: '400' }] }, stones: { mode: 'per_piece', rates: [{ kind: 'diamond', grade: null, amount: '1500' }, { kind: 'gemstone', grade: null, amount: '900' }] } }),
      piece,
      c,
    );
    expect(amounts(b).making).toBe('1120000'); // 11.2 × 500 × 2
    expect(amounts(b).stone_1).toBe('900000'); // 3 × 1500 × 2
    expect(amounts(b).stone_2).toBe('180000'); // 1 × 900 × 2
  });
  it('a stone without a rate is an error, never priced at zero', () => {
    expect(() => calculatePrice(rule({ ...full, stones: { mode: 'per_carat', rates: [{ kind: 'gemstone', grade: null, amount: '1' }] } }), piece, c)).toThrow(/No stone rate for diamond/);
  });
  it('percent-of-metal and per-piece making; fixed discount capped and allocated by largest remainder', () => {
    const b = calculatePrice(
      rule({ base: { kind: 'metal', weightBasis: 'gross' }, making: { mode: 'percent_of_metal', percent: '12.5' }, discount: { mode: 'fixed', value: '100000', appliesTo: ['making'] } }),
      item(),
      ctx(),
    );
    // making = 64067.625 × 12.5% = 8008.453125 → 800845 ; discount capped at the making amount
    expect(amounts(b).making).toBe('800845');
    expect(b.discountMinor).toBe('800845');
    expect(b.warnings.join(' ')).toMatch(/capped/);
  });
  it('allocates remainders deterministically', () => {
    expect(allocate('10', ['1', '1', '1'])).toEqual(['4', '3', '3']);
    expect(allocate('7', ['500', '250', '250'])).toEqual(['3', '2', '2']); // 3.5/1.75/1.75: remainders go to .75s
    expect(allocate('0', ['5'])).toEqual(['0']);
  });
  it('stale rates are flagged in the breakdown', () => {
    const b = calculatePrice(rule({ base: { kind: 'metal', weightBasis: 'net' } }), item(), ctx({ rate: { id: 'r', ratePerG: '1', currency: 'INR', stale: true } }));
    expect(b.warnings.join(' ')).toMatch(/stale/);
  });
});

describe('list prices for general commerce (PR-10)', () => {
  it('prices from the price book with per-piece charges, no metal rate needed', () => {
    const b = calculatePrice(
      rule({ base: { kind: 'list_price' }, charges: [{ code: 'packing', label: 'Gift box', mode: 'per_piece', amount: '49.99' }] }),
      item({ productType: 'standard', metal: null, purityId: null, quantity: 3 }),
      ctx({ rate: null, listPrice: '1299.95' }),
    );
    expect(amounts(b)).toEqual({ list_price: '389985', charge_1_packing: '14997' });
    expect(b.totalMinor).toBe('404982');
  });
  it('rejects metal-only options on a list-price base', () => {
    expect(() => rule({ base: { kind: 'list_price' }, wastage: { percent: '1' } })).toThrow();
  });
});

describe('rule conditions and conflicts (PR-06/07)', () => {
  const c = (v: unknown) => RuleConditions.parse(v);
  it('matches when each non-empty list contains the value', () => {
    expect(ruleMatches(c({}), item())).toBe(true);
    expect(ruleMatches(c({ metals: ['gold'], purityIds: [P22] }), item())).toBe(true);
    expect(ruleMatches(c({ metals: ['silver'] }), item())).toBe(false);
    expect(ruleMatches(c({ productTypes: ['standard'] }), item())).toBe(false);
  });
  it('detects overlapping conditions', () => {
    expect(conditionsOverlap(c({ metals: ['gold'] }), c({}))).toBe(true);
    expect(conditionsOverlap(c({ metals: ['gold'] }), c({ metals: ['silver'] }))).toBe(false);
    expect(conditionsOverlap(c({ metals: ['gold'], productTypes: ['jewellery'] }), c({ metals: ['gold', 'silver'] }))).toBe(true);
  });
  it('validates the DSL', () => {
    expect(() => rule({ base: { kind: 'metal', weightBasis: 'net' }, making: { mode: 'tiered_per_gram', tiers: [{ upToG: null, amount: '1' }, { upToG: '5', amount: '1' }] } })).toThrow();
    expect(() => rule({ base: { kind: 'metal', weightBasis: 'net' }, discount: { mode: 'percent', value: '120', appliesTo: ['making'] } })).toThrow();
    expect(() => rule({ base: { kind: 'metal', weightBasis: 'net' }, making: { mode: 'per_gram', amount: '1.5e3' } })).toThrow();
  });
});
