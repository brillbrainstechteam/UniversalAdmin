import Decimal from 'decimal.js';
import type { RateProvider } from './dto/pricing';

/**
 * Metal-rate provider registry with honest tiers (ADR-021, OD-8). A provider is "available" only when built and
 * tested end to end. No licensed market-data provider is connected in this build.
 */
export const RATE_PROVIDERS: RateProvider[] = [
  {
    key: 'simulator',
    label: 'Rate simulator (test data)',
    tier: 'available',
    simulated: true,
    description:
      'Deterministic sample values for exercising freshness, approval and quotes. Every value is labelled SIMULATED and is never market data.',
    blockedBy: [],
    units: ['per_g'],
  },
  {
    key: 'licensed_feed',
    label: 'Licensed metal-rate feed',
    tier: 'blocked',
    simulated: false,
    description: 'A licensed market-data provider (bullion association, exchange or data vendor) for automatic rate proposals.',
    blockedBy: [
      'Signed data licence covering display and pricing use',
      'API documentation and sandbox credentials (stored as a secret reference)',
      'Confirmed metals, purities, unit, currency, market and publication schedule',
    ],
    units: [],
  },
];

/** Simulator base values per metal for fine (1.000) metal, in INR per gram. Illustrative only. */
export const SIMULATOR_BASE_PER_G: Record<string, string> = {
  gold: '7200.00',
  silver: '92.00',
  platinum: '3100.00',
  palladium: '3300.00',
};

/** Deterministic simulator value: base × fineness + 5 × tick, rounded half-up to 2 dp (illustrative only). */
export function simulatorRateValue(metal: string, fineness: string, tick: number): string | null {
  const base = SIMULATOR_BASE_PER_G[metal];
  if (!base) return null;
  return new Decimal(base).times(fineness).plus(5 * tick).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}
