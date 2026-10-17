import type { ErrorCode } from '@uc/contracts';

/** Domain/application error with a stable code. Rendered by `ErrorFilter` as {code,message,details,correlationId}. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const Errors = {
  validation: (details: unknown, message = 'Request validation failed') =>
    new AppError(400, 'VALIDATION_FAILED', message, details),
  unauthenticated: (message = 'Authentication required') => new AppError(401, 'UNAUTHENTICATED', message),
  forbidden: (message = 'You do not have access to this resource') => new AppError(403, 'FORBIDDEN', message),
  permission: (permission: string) =>
    new AppError(403, 'PERMISSION_DENIED', `Missing permission ${permission}`, { permission }),
  notFound: (entity: string) => new AppError(404, 'NOT_FOUND', `${entity} not found`),
  versionConflict: (currentVersion?: number) =>
    new AppError(409, 'VERSION_CONFLICT', 'This record was changed by someone else. Reload and try again.', {
      currentVersion,
    }),
  duplicate: (field: string, message?: string) =>
    new AppError(409, 'DUPLICATE', message ?? `${field} is already in use`, { field }),
  conflict: (code: ErrorCode, message: string, details?: unknown) =>
    new AppError(409, code, message, details),
  unprocessable: (code: ErrorCode, message: string, details?: unknown) =>
    new AppError(422, code, message, details),
  featureNotEntitled: (feature: string) =>
    new AppError(403, 'FEATURE_NOT_ENTITLED', `Feature "${feature}" is not enabled for this merchant`, {
      feature,
    }),
};
