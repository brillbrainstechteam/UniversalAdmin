import { Injectable } from '@nestjs/common';
import { idempotencyKeys, sha256 } from '@uc/db';
import { and, eq, lt } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { AppError } from './errors';

const KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const TTL_MS = 24 * 3600_000;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Idempotency-Key handling (ADR-007): same key + same request replays the stored response; same key with a
 * different request is rejected; a concurrent duplicate gets 409 while the first is in flight.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly db: DbService) {}

  async run<T>(
    options: { scope: string; key: string | undefined; route: string; request: unknown },
    execute: () => Promise<{ status: number; body: T }>,
  ): Promise<IdempotentResult<T>> {
    const { scope, key, route } = options;
    if (!key) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
    if (!KEY_RE.test(key)) {
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        'Idempotency-Key must be 8-128 characters [A-Za-z0-9_.:-]',
      );
    }
    const requestHash = sha256(`${route}\n${stableStringify(options.request)}`);

    // Expired keys can be reused.
    await this.db.system((tx) =>
      tx
        .delete(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.scope, scope),
            eq(idempotencyKeys.key, key),
            lt(idempotencyKeys.expiresAt, new Date()),
          ),
        ),
    );

    const inserted = await this.db.system((tx) =>
      tx
        .insert(idempotencyKeys)
        .values({ scope, key, route, requestHash, expiresAt: new Date(Date.now() + TTL_MS) })
        .onConflictDoNothing()
        .returning({ id: idempotencyKeys.id }),
    );

    if (inserted.length === 0) {
      const [existing] = await this.db.system((tx) =>
        tx
          .select()
          .from(idempotencyKeys)
          .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key))),
      );
      if (!existing)
        throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Request with this key is in progress');
      if (existing.requestHash !== requestHash || existing.route !== route) {
        throw new AppError(
          422,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key was already used for a different request',
        );
      }
      if (existing.status !== 'completed') {
        throw new AppError(
          409,
          'IDEMPOTENCY_IN_PROGRESS',
          'A request with this Idempotency-Key is still in progress',
        );
      }
      return { status: existing.responseStatus ?? 200, body: existing.responseBody as T, replayed: true };
    }

    try {
      const result = await execute();
      await this.db.system((tx) =>
        tx
          .update(idempotencyKeys)
          .set({ status: 'completed', responseStatus: result.status, responseBody: result.body as object })
          .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key))),
      );
      return { ...result, replayed: false };
    } catch (error) {
      // Failed requests release the key so the client can retry (nothing was committed).
      await this.db.system((tx) =>
        tx.delete(idempotencyKeys).where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key))),
      );
      throw error;
    }
  }
}
