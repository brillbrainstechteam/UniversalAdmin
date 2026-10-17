'use client';

import { ApiError } from '@uc/ui';
import type { z } from '@uc/contracts';

/** Client-side validation with the same shared schema the API uses; returns field errors keyed by path. */
export function validate(
  schema: z.ZodTypeAny,
  value: unknown,
): { ok: true } | { ok: false; errors: Record<string, string> } {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true };
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.');
    errors[key] ??= issue.message;
  }
  return { ok: false, errors };
}

/** Merge server-side field errors (VALIDATION_FAILED details) or return a general message. */
export function serverErrors(error: unknown): { fields: Record<string, string>; message: string | null } {
  if (error instanceof ApiError) {
    const fields = error.fieldErrors();
    if (error.code === 'DUPLICATE' && typeof (error.details as { field?: string })?.field === 'string') {
      fields[(error.details as { field: string }).field] = error.message;
    }
    if (Object.keys(fields).length) return { fields, message: null };
    if (error.code === 'VERSION_CONFLICT') {
      return {
        fields,
        message:
          'Someone else saved changes first. Reload to get the latest version, then re-apply your edits.',
      };
    }
    return { fields, message: error.message };
  }
  return { fields: {}, message: error instanceof Error ? error.message : 'Unexpected error' };
}

/** Removes keys whose value equals the original, so PATCH only carries edited fields. */
export function changedFields<T extends Record<string, unknown>>(original: T, edited: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(edited) as (keyof T)[]) {
    if (JSON.stringify(edited[key]) !== JSON.stringify(original[key])) out[key] = edited[key];
  }
  return out;
}
