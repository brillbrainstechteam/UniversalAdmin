import { Errors } from './errors';

/**
 * Opaque keyset cursor: base64url JSON of [sortValue, id]. Clients must treat it as opaque.
 */
export function encodeCursor(sortValue: string | number | null, id: string): string {
  return Buffer.from(JSON.stringify([sortValue, id])).toString('base64url');
}

export function decodeCursor(
  cursor: string | undefined,
): { sortValue: string | number | null; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      (typeof parsed[0] === 'string' || typeof parsed[0] === 'number' || parsed[0] === null) &&
      typeof parsed[1] === 'string' &&
      /^[0-9a-f-]{36}$/i.test(parsed[1])
    ) {
      return { sortValue: parsed[0], id: parsed[1] };
    }
  } catch {
    /* fall through */
  }
  throw Errors.validation([{ path: 'cursor', message: 'Invalid cursor' }]);
}

/** Given limit+1 fetched rows, returns the page and the next cursor. */
export function paginate<T extends { id: string }>(
  rows: T[],
  limit: number,
  sortValueOf: (row: T) => string | number | null,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(sortValueOf(last), last.id) : null };
}
