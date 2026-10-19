import type { ErrorBody } from '@uc/contracts';

/** Typed error carrying the API's {code,message,details,correlationId}. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly correlationId?: string,
  ) {
    super(message);
  }

  /** Field-level validation messages keyed by dotted path. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (this.code === 'VALIDATION_FAILED' && Array.isArray(this.details)) {
      for (const d of this.details as { path?: string; message?: string }[]) {
        if (d.path && d.message && !out[d.path]) out[d.path] = d.message;
      }
    }
    return out;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  tenantId?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Extra request headers (e.g. the buyer portal's X-Company-Id). */
  headers?: Record<string, string>;
}

/**
 * Browser API client. Calls go to same-origin `/api/*`, which the Next.js app proxies to the API (ADR-003),
 * so session cookies stay HttpOnly/SameSite=Strict and no CORS is needed.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const url = new URL(`/api${path}`, window.location.origin);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-UC-CSRF'] = '1';
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.tenantId) headers['X-Tenant-Id'] = options.tenantId;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  Object.assign(headers, options.headers ?? {});

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin',
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.');
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON (e.g. proxy error page) */
  }
  if (!response.ok) {
    const body = (data ?? {}) as Partial<ErrorBody>;
    throw new ApiError(
      response.status,
      body.code ?? (response.status >= 500 ? 'INTERNAL' : 'UNKNOWN'),
      body.message ?? `Request failed (${response.status})`,
      body.details,
      body.correlationId ?? response.headers.get('x-correlation-id') ?? undefined,
    );
  }
  return data as T;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** multipart/form-data upload (single "file" field) through the same-origin proxy. */
export async function apiUpload<T>(path: string, file: File, tenantId: string): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: 'POST',
      body: form,
      headers: { 'X-UC-CSRF': '1', 'X-Tenant-Id': tenantId, Accept: 'application/json' },
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.');
  }
  const data = (await response.json().catch(() => ({}))) as Partial<ErrorBody> & T;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      data.code ?? 'UNKNOWN',
      data.message ?? `Upload failed (${response.status})`,
      data.details,
      data.correlationId,
    );
  }
  return data;
}
