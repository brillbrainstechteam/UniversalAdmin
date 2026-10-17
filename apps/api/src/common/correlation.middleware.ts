import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import type { Logger } from 'pino';
import type { AppRequest } from './request';

const VALID_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Accepts a well-formed inbound X-Correlation-Id or generates one; echoes it and logs the request. */
export function correlationMiddleware(logger: Logger) {
  return (req: AppRequest, res: Response, next: NextFunction): void => {
    const inbound = req.header('x-correlation-id');
    req.correlationId = inbound && VALID_ID.test(inbound) ? inbound : randomUUID();
    res.setHeader('X-Correlation-Id', req.correlationId);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      logger.info(
        {
          correlationId: req.correlationId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms: Number(process.hrtime.bigint() - started) / 1e6,
          userId: req.auth?.userId,
          tenantId: req.tenant?.tenantId,
        },
        'request',
      );
    });
    next();
  };
}
