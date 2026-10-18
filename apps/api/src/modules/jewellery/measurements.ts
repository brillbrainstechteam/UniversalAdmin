import {
  MeasurementError,
  STONE_KINDS,
  absDiff,
  compareGrams,
  computeFine,
  gramsToCarats,
  sumGrams,
  toGrams,
  withinTolerance,
  type ComponentInput,
  type MeasurementCheck,
  type WeightInput,
} from '@uc/contracts';
import { AppError, Errors } from '../../common/errors';

export interface PurityInfo {
  id: string;
  metal: string;
  code: string;
  label: string;
  fineness: string;
  confirmed: boolean;
  status: string;
}

export interface Settings {
  weightToleranceG: string;
  fineScale: number;
  huidFormat: 'bis_6_alnum' | 'free_text';
}

export interface NormalizedComponent {
  kind: ComponentInput['kind'];
  description: string;
  shape: string | null;
  grade: string | null;
  count: number;
  weightG: string;
  purityId: string | null;
  metal: string | null;
  certificate: string | null;
  raw: Record<string, unknown>;
}

/** Collects validation issues with request paths instead of failing on the first one. */
export class Issues {
  readonly list: { path: string; message: string }[] = [];
  add(path: string, message: string) {
    this.list.push({ path, message });
  }
  grams(path: string, input: WeightInput | null | undefined): string | null {
    if (!input) return null;
    try {
      return toGrams(input.value, input.unit);
    } catch (error) {
      this.add(`${path}.value`, error instanceof MeasurementError ? error.message : 'Invalid weight');
      return null;
    }
  }
  throwIfAny() {
    if (this.list.length) throw Errors.validation(this.list);
  }
}

export function normalizeComponents(
  issues: Issues,
  path: string,
  inputs: ComponentInput[],
  purities: Map<string, PurityInfo>,
): NormalizedComponent[] {
  return inputs.map((c, i) => {
    const purity = c.purityId ? purities.get(c.purityId) : undefined;
    if (c.purityId && (!purity || purity.status !== 'active'))
      issues.add(`${path}.${i}.purityId`, 'Unknown or inactive purity');
    return {
      kind: c.kind,
      description: c.description,
      shape: c.shape ?? null,
      grade: c.grade ?? null,
      count: c.count,
      weightG: issues.grams(`${path}.${i}.weight`, c.weight) ?? '0.000000',
      purityId: c.purityId ?? null,
      metal: purity?.metal ?? null,
      certificate: c.certificate ?? null,
      raw: { weight: c.weight },
    };
  });
}

/** Fine weight: entered (cross-checked later) or computed with formula provenance. */
export function resolveFine(
  issues: Issues,
  path: string,
  entered: WeightInput | null | undefined,
  netG: string | null,
  purity: PurityInfo,
  components: NormalizedComponent[],
  purities: Map<string, PurityInfo>,
  settings: Settings,
): { fineG: string | null; source: 'computed' | 'entered' | null; formula: Record<string, unknown> | null } {
  if (entered) {
    return { fineG: issues.grams(path, entered), source: 'entered', formula: null };
  }
  const metalComponents = components
    .filter((c) => c.kind === 'metal' && c.purityId)
    .map((c) => ({ weightG: c.weightG, fineness: purities.get(c.purityId!)?.fineness ?? '0' }));
  if (!netG && metalComponents.length === 0) return { fineG: null, source: null, formula: null };
  const { fineG, formula } = computeFine(
    { netG: netG ?? '0', fineness: purity.fineness, metalComponents },
    settings.fineScale,
  );
  return { fineG, source: 'computed', formula };
}

/** Non-blocking consistency checks (spec 04: gross is never silently overwritten as net + stone). */
export function measurementChecks(
  m: {
    grossG: string | null;
    netG: string | null;
    stoneG: string | null;
    fineG: string | null;
    fineSource: string | null;
    weightExceptionReason?: string | null;
  },
  purity: PurityInfo,
  components: { kind: string; weightG: string; purityId: string | null }[],
  purities: Map<string, PurityInfo>,
  settings: Settings,
): MeasurementCheck[] {
  const checks: MeasurementCheck[] = [];
  const tol = settings.weightToleranceG;
  if (m.grossG && m.netG && compareGrams(m.netG, m.grossG) > 0) {
    checks.push({
      code: 'NET_EXCEEDS_GROSS',
      severity: 'info',
      message: `Net exceeds gross (recorded exception: ${m.weightExceptionReason ?? 'none'})`,
    });
  }
  if (m.grossG && m.netG) {
    const expected = sumGrams([m.netG, m.stoneG ?? '0']);
    if (!withinTolerance(m.grossG, expected, tol)) {
      checks.push({
        code: 'GROSS_MISMATCH',
        severity: 'warning',
        message: `Gross ${m.grossG} g differs from net + stone (${expected} g) by ${absDiff(m.grossG, expected)} g — check for other materials or entry errors`,
      });
    }
  }
  const stones = components.filter((c) => (STONE_KINDS as readonly string[]).includes(c.kind));
  if (stones.length && m.stoneG !== null) {
    const total = sumGrams(stones.map((s) => s.weightG));
    if (!withinTolerance(total, m.stoneG, tol)) {
      checks.push({
        code: 'STONE_COMPONENT_MISMATCH',
        severity: 'warning',
        message: `Stone weight ${m.stoneG} g differs from listed stones (${total} g = ${gramsToCarats(total)} ct)`,
      });
    }
  }
  if (m.fineSource === 'entered' && m.fineG && m.netG) {
    const metalComponents = components
      .filter((c) => c.kind === 'metal' && c.purityId)
      .map((c) => ({ weightG: c.weightG, fineness: purities.get(c.purityId!)?.fineness ?? '0' }));
    const expected = computeFine(
      { netG: m.netG, fineness: purity.fineness, metalComponents },
      settings.fineScale,
    ).fineG;
    if (!withinTolerance(m.fineG, expected, tol)) {
      checks.push({
        code: 'FINE_DEVIATION',
        severity: 'warning',
        message: `Entered fine ${m.fineG} g differs from computed ${expected} g`,
      });
    }
  }
  if (!purity.confirmed) {
    checks.push({
      code: 'PURITY_UNCONFIRMED',
      severity: 'info',
      message: `${purity.label} fineness is a platform default — confirm it in Jewellery settings`,
    });
  }
  return checks;
}

export function normalizeHuid(
  issues: Issues,
  path: string,
  value: string | null | undefined,
  settings: Settings,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === '') return null;
  const huid = value.trim().toUpperCase();
  if (settings.huidFormat === 'bis_6_alnum' && !/^[A-Z0-9]{6}$/.test(huid)) {
    issues.add(path, 'HUID must be 6 letters/digits (format configurable in Jewellery settings)');
  }
  if (huid.length > 32) issues.add(path, 'HUID is too long');
  return huid;
}

export const notJewellery = () =>
  new AppError(
    409,
    'INVALID_STATE_TRANSITION',
    'Jewellery data is only available on products of type "jewellery"',
  );
