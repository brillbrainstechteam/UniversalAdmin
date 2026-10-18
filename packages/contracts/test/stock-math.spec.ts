import { describe, expect, it } from 'vitest';
import {
  CreateReservationRequest,
  CreateTransferRequest,
  QuantityError,
  ReceiptRequest,
  formatQty,
  qty,
  qtyAdd,
  qtyCmp,
  qtyIsWhole,
  qtyMax0,
  qtyNeg,
  qtyProblem,
  qtySub,
} from '../src';

const U = '00000000-0000-4000-8000-000000000001';

describe('stock quantity math (exact decimals, Phase 04)', () => {
  it('adds and subtracts without float drift', () => {
    expect(qtyAdd('0.1', '0.2')).toBe('0.300000');
    expect(qtyAdd('12.345678', '0.000001', '-2')).toBe('10.345679');
    expect(qtySub('1', '0.999999')).toBe('0.000001');
    expect(qtyNeg('3')).toBe('-3.000000');
    expect(qty('7')).toBe('7.000000');
  });

  it('compares, floors at zero and recognises whole numbers', () => {
    expect(qtyCmp('2.000000', '2')).toBe(0);
    expect(qtyCmp('0.000001', '0')).toBe(1);
    expect(qtyMax0('-0.5')).toBe('0.000000');
    expect(qtyMax0('4.25')).toBe('4.250000');
    expect(qtyIsWhole('3.000000')).toBe(true);
    expect(qtyIsWhole('3.5')).toBe(false);
  });

  it('validates quantities per unit', () => {
    expect(qtyProblem('1.5', 'pcs')).toMatch(/whole/);
    expect(qtyProblem('1.5', 'g')).toBeNull();
    expect(qtyProblem('0', 'pcs')).toMatch(/zero/);
    expect(qtyProblem('0', 'pcs', { allowZero: true })).toBeNull();
    expect(qtyProblem('-2', 'pcs')).toMatch(/negative/);
    expect(qtyProblem('-2', 'pcs', { signed: true })).toBeNull();
    expect(qtyProblem('1.1234567', 'g')).toMatch(/6 decimals/);
    expect(qtyProblem('1e3', 'g')).not.toBeNull();
    expect(() => qtyAdd('NaN')).toThrow(QuantityError);
  });

  it('formats pieces without decimals and grams with three or more', () => {
    expect(formatQty('5.000000', 'pcs')).toBe('5');
    expect(formatQty('12.500000', 'g')).toBe('12.500');
    expect(formatQty('0.123456', 'g')).toBe('0.123456');
    expect(formatQty(null)).toBe('—');
  });

  it('request schemas require exactly one of quantity / pieces and positive quantities', () => {
    expect(ReceiptRequest.safeParse({ locationId: U, lines: [{ variantId: U }] }).success).toBe(false);
    expect(
      ReceiptRequest.safeParse({ locationId: U, lines: [{ variantId: U, quantity: '1', serialItemIds: [U] }] }).success,
    ).toBe(false);
    expect(ReceiptRequest.safeParse({ locationId: U, lines: [{ variantId: U, quantity: '0' }] }).success).toBe(false);
    expect(CreateReservationRequest.safeParse({ variantId: U, quantity: '-1' }).success).toBe(false);
    expect(
      CreateTransferRequest.safeParse({ fromLocationId: U, toLocationId: U, lines: [{ variantId: U, quantity: '1' }] })
        .success,
    ).toBe(false);
  });
});
