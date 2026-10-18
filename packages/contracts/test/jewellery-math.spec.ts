import { describe, expect, it } from 'vitest';
import {
  MeasurementError,
  absDiff,
  compareGrams,
  computeFine,
  fineWeight,
  formatGrams,
  gramsToCarats,
  sumGrams,
  toGrams,
  withinTolerance,
} from '../src/jewellery-math';

describe('unit conversion to canonical grams (J-01)', () => {
  it.each([
    ['12.345', 'g', '12.345000'],
    ['0.000001', 'g', '0.000001'],
    ['1234.5', 'mg', '1.234500'],
    ['0.001', 'mg', '0.000001'],
    ['1.5', 'kg', '1500.000000'],
    ['0.123456', 'kg', '123.456000'],
    ['1', 'ct', '0.200000'],
    ['0.25', 'ct', '0.050000'],
    ['2.34568', 'ct', '0.469136'],
  ] as const)('%s %s = %s g', (value, unit, grams) => {
    expect(toGrams(value, unit)).toBe(grams);
  });

  it('rejects precision loss, negatives, exponents and garbage', () => {
    expect(() => toGrams('0.0001', 'mg')).toThrow(MeasurementError); // 0.0000001 g
    expect(() => toGrams('0.000003', 'ct')).toThrow(MeasurementError); // 0.0000006 g
    expect(() => toGrams('2.345678', 'ct')).toThrow(MeasurementError); // 0.4691356 g (7 dp)
    expect(() => toGrams('-1', 'g')).toThrow(MeasurementError);
    expect(() => toGrams('1e3', 'g')).toThrow(MeasurementError);
    expect(() => toGrams('12,5', 'g')).toThrow(MeasurementError);
    expect(() => toGrams('1.1234567', 'g')).toThrow(MeasurementError);
  });

  it('converts grams back to carats exactly', () => {
    expect(gramsToCarats('0.469136')).toBe('2.345680');
    expect(gramsToCarats('0.200000')).toBe('1.000000');
  });
});

describe('fine weight (J-01)', () => {
  it.each([
    // net, fineness, scale, expected — values chosen where binary floats drift.
    ['10.123456', '0.916', 3, '9.273000'], // 9.273085696 → 9.273
    ['4.612', '0.916', 3, '4.225000'], // 4.224592 → 4.225 (half-up at 4th digit 5)
    ['1.25', '0.9', 2, '1.130000'], // 1.125 exactly → half-up 1.13 (float gives 1.12)
    ['0.1', '0.3', 6, '0.030000'], // float 0.1*0.3 = 0.030000000000000002
    ['1000000', '0.999', 3, '999000.000000'],
    ['3.050', '0.750', 3, '2.288000'], // 2.2875 → 2.288
    ['0', '0.916', 3, '0.000000'],
  ] as const)('%s g × %s @%i dp = %s', (net, fineness, scale, expected) => {
    expect(fineWeight(net, fineness, scale)).toBe(expected);
  });

  it('sums metal components before rounding once (multi-metal pieces)', () => {
    // 2.0005 × 0.75 = 1.500375 ; 1.0005 × 0.925 = 0.9254625 ; exact sum 2.4258375 → 2.426
    const res = computeFine(
      {
        netG: '999',
        fineness: '0.916',
        metalComponents: [
          { weightG: '2.000500', fineness: '0.750' },
          { weightG: '1.000500', fineness: '0.925' },
        ],
      },
      3,
    );
    expect(res.fineG).toBe('2.426000');
    expect(res.formula.id).toBe('metal_components_x_fineness_v1');
    // Rounding each component first would give 1.500 + 0.925 = 2.425 — a different, wrong answer.
  });

  it('records formula provenance for net × fineness', () => {
    const res = computeFine({ netG: '4.612000', fineness: '0.916000' }, 3);
    expect(res).toEqual({
      fineG: '4.225000',
      formula: { id: 'net_x_fineness_v1', scale: 3, inputs: { netG: '4.612000', fineness: '0.916000' } },
    });
  });
});

describe('exact comparisons', () => {
  it('compares, sums and checks tolerance without float error', () => {
    expect(sumGrams(['0.100000', '0.200000'])).toBe('0.300000'); // float: 0.30000000000000004
    expect(compareGrams('0.300000', sumGrams(['0.1', '0.2']))).toBe(0);
    expect(compareGrams('10.000001', '10.000000')).toBe(1);
    expect(absDiff('4.600', '4.612')).toBe('0.012000');
    expect(withinTolerance('4.600', '4.610', '0.010')).toBe(true);
    expect(withinTolerance('4.600', '4.611', '0.010')).toBe(false);
    expect(formatGrams('4.2245', 3)).toBe('4.225 g');
    expect(formatGrams(null)).toBe('—');
  });
});
