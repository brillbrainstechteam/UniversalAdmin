import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api';

describe('ApiError', () => {
  it('maps VALIDATION_FAILED details to field errors keyed by path (first message wins)', () => {
    const error = new ApiError(400, 'VALIDATION_FAILED', 'Request validation failed', [
      { path: 'timezone', message: 'Unknown IANA time zone' },
      { path: 'theme.primaryColor', message: 'Use a 6-digit hex colour' },
      { path: 'timezone', message: 'second message ignored' },
    ]);
    expect(error.fieldErrors()).toEqual({
      timezone: 'Unknown IANA time zone',
      'theme.primaryColor': 'Use a 6-digit hex colour',
    });
  });

  it('returns no field errors for non-validation failures', () => {
    expect(new ApiError(409, 'VERSION_CONFLICT', 'Changed', { currentVersion: 3 }).fieldErrors()).toEqual({});
  });
});
