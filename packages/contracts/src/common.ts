import { z } from './z';

export const Uuid = z.string().uuid();
export const Timestamp = z.string().datetime({ offset: false }).openapi({ description: 'UTC ISO-8601 timestamp' });
export const Version = z.number().int().nonnegative().openapi({ description: 'Optimistic-lock version' });

/** ISO 4217 code, upper-case. */
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, 'Must be a 3-letter ISO 4217 code');
/** ISO 3166-1 alpha-2, upper-case. */
export const CountryCode = z.string().regex(/^[A-Z]{2}$/, 'Must be a 2-letter ISO 3166-1 code');
/** BCP-47 language tag (simplified). */
export const Locale = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'Must be a locale like en-IN');

// Probe with DateTimeFormat: accepts canonical names and aliases (e.g. Asia/Kolkata and Asia/Calcutta).
function isTimeZone(tz: string): boolean {
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
export const TimeZone = z.string().max(64).refine(isTimeZone, 'Unknown IANA time zone');

/** Lower-case slug used for tenant/store/channel/location codes. */
export const Code = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lower-case letters, digits and single hyphens');

export const Email = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254);

export const Reason = z.string().trim().min(5, 'Give a reason of at least 5 characters').max(500);

/** Exact decimal serialized as string (never JS float). */
export const DecimalString = z.string().regex(/^-?\d{1,14}(\.\d{1,6})?$/, 'Must be a decimal string');
/** Money in integer minor units serialized as string plus currency. */
export const Money = z.object({ amountMinor: z.string().regex(/^-?\d+$/), currency: CurrencyCode }).openapi('Money');

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(512).optional(),
});
export type PageQuery = z.infer<typeof PageQuery>;

export function pageOf<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const IdParam = z.object({ id: Uuid });
