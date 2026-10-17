import pino, { type Logger } from 'pino';

/** Structured logger. Credentials, cookies and tokens are redacted at the transport level. */
export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'uc-api' },
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["x-storefront-key"]',
        'res.headers["set-cookie"]',
        '*.password',
        '*.token',
        '*.passwordHash',
        '*.secret',
      ],
      censor: '[REDACTED]',
    },
  });
}

export const LOGGER = Symbol('LOGGER');
