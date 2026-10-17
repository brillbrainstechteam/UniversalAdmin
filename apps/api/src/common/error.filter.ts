import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { ErrorBody, ErrorCode } from '@uc/contracts';
import type { Response } from 'express';
import type { Logger } from 'pino';
import { AppError } from './errors';
import type { AppRequest } from './request';

/** Maps Postgres constraint names to user-facing field names for 409 DUPLICATE responses. */
const UNIQUE_FIELDS: Record<string, string> = {
  tenants_slug_uq: 'slug',
  users_email_uq: 'email',
  stores_tenant_code_uq: 'code',
  channels_tenant_code_uq: 'code',
  locations_tenant_code_uq: 'code',
  roles_tenant_key_uq: 'name',
  channel_domains_hostname_uq: 'hostname',
  invitations_pending_email_uq: 'email',
  memberships_tenant_user_uq: 'user',
};

interface PgError {
  code?: string;
  constraint?: string;
}

const STATUS_CODES: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
};

@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<AppRequest>();
    const res = http.getResponse<Response>();
    const correlationId = req.correlationId ?? 'unknown';

    let status = 500;
    let body: Omit<ErrorBody, 'correlationId'> = {
      code: 'INTERNAL',
      message: 'An unexpected error occurred',
    };

    // Drizzle wraps driver errors; unwrap the pg error from `cause`.
    const pg = ((exception as { cause?: PgError })?.cause ?? exception) as PgError;

    if (exception instanceof AppError) {
      status = exception.status;
      body = { code: exception.code, message: exception.message, details: exception.details };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const code = STATUS_CODES[status] ?? 'INTERNAL';
      body = {
        code,
        message: status === 404 ? 'Route not found' : exception.message,
      };
    } else if (pg?.code === '23505') {
      status = 409;
      const field = (pg.constraint && UNIQUE_FIELDS[pg.constraint]) ?? 'value';
      body = { code: 'DUPLICATE', message: `${field} is already in use`, details: { field } };
    } else if (pg?.code === '23503') {
      status = 422;
      body = { code: 'VALIDATION_FAILED', message: 'Referenced record does not exist in this tenant' };
    } else if (pg?.code === '40001' || pg?.code === '40P01') {
      status = 409;
      body = { code: 'CONFLICT', message: 'Concurrent update detected, please retry' };
    }

    if (status >= 500) {
      this.logger.error(
        { err: exception, correlationId, path: req.path, method: req.method },
        'request failed',
      );
    }
    res.status(status).json({ ...body, correlationId } satisfies ErrorBody);
  }
}
