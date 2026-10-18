import { optionKey, type ProductOption, type ProductStatus } from '@uc/contracts';
import { AppError, Errors } from '../../common/errors';

/**
 * Variant option values must name exactly the product's option axes, using declared values.
 * Products without options can have exactly one variant (empty option key).
 */
export function checkVariantOptions(
  options: ProductOption[],
  values: Record<string, string>,
  path = 'optionValues',
): { key: string; values: Record<string, string> } {
  const names = options.map((o) => o.name);
  const given = Object.keys(values);
  const missing = names.filter((n) => !given.includes(n));
  const extra = given.filter((g) => !names.includes(g));
  if (missing.length || extra.length) {
    throw Errors.validation([
      {
        path,
        message: options.length
          ? `Variant must set exactly these options: ${names.join(', ')}`
          : 'This product has no options, so variants cannot have option values',
      },
    ]);
  }
  for (const option of options) {
    const value = values[option.name]!;
    if (!option.values.some((v) => v.toLowerCase() === value.toLowerCase())) {
      throw Errors.validation([
        { path: `${path}.${option.name}`, message: `"${value}" is not a value of option ${option.name}` },
      ]);
    }
  }
  return { key: optionKey(values), values };
}

const TRANSITIONS: Record<ProductStatus, ProductStatus[]> = {
  draft: ['active', 'archived'],
  active: ['draft', 'archived'],
  archived: ['draft'],
};

export function assertTransition(from: ProductStatus, to: ProductStatus): void {
  if (from === to) return;
  if (!TRANSITIONS[from].includes(to)) {
    throw new AppError(409, 'INVALID_STATE_TRANSITION', `A ${from} product cannot become ${to}`, {
      from,
      to,
    });
  }
}
