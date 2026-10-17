const SENSITIVE_KEY =
  /pass(word)?|secret|token|hash|credential|authorization|cookie|api[-_]?key|otp|cvv|card/i;
export const REDACTED = '[REDACTED]';

/** Deep-copies a value replacing sensitive keys. Used for audit snapshots and logs. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Returns only the keys whose (JSON) value changed, as redacted old/new snapshots. */
export function diff(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): { oldValues: Record<string, unknown> | null; newValues: Record<string, unknown> | null } {
  if (!before || !after) {
    return {
      oldValues: before ? (redact(before) as Record<string, unknown>) : null,
      newValues: after ? (redact(after) as Record<string, unknown>) : null,
    };
  }
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'updatedAt' || key === 'version') continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      oldValues[key] = before[key];
      newValues[key] = after[key];
    }
  }
  return {
    oldValues: redact(oldValues) as Record<string, unknown>,
    newValues: redact(newValues) as Record<string, unknown>,
  };
}
