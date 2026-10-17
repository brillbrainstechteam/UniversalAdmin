import { randomUUID } from 'node:crypto';
import type { DomainEventType, EventEnvelope } from '@uc/contracts';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Db, Executor } from './client';
import { systemTx } from './client';
import { outboxEvents, processedEvents } from './schema';

export interface OutboxInput {
  tenantId: string | null;
  eventType: DomainEventType;
  eventVersion?: number;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion?: number;
  correlationId?: string | null;
  causationId?: string | null;
  payload: Record<string, unknown>;
}

/** Insert an event in the SAME transaction as the business change (ADR-008). Returns the event id. */
export async function enqueueEvent(tx: Executor, input: OutboxInput): Promise<string> {
  const id = randomUUID();
  await tx.insert(outboxEvents).values({
    id,
    tenantId: input.tenantId,
    eventType: input.eventType,
    eventVersion: input.eventVersion ?? 1,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion ?? 0,
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    payload: input.payload,
  });
  return id;
}

export type OutboxRow = typeof outboxEvents.$inferSelect;

export function toEnvelope(row: OutboxRow): EventEnvelope {
  return {
    eventId: row.id,
    eventType: row.eventType as DomainEventType,
    eventVersion: row.eventVersion,
    tenantId: row.tenantId,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    aggregateVersion: row.aggregateVersion,
    occurredAt: row.occurredAt.toISOString(),
    correlationId: row.correlationId,
    causationId: row.causationId,
    payload: row.payload as Record<string, unknown>,
  };
}

export interface RelayOptions {
  batchSize?: number;
  maxAttempts?: number;
  /** Base backoff in ms; delay = base * 2^(attempts-1), capped at 15 minutes. */
  backoffBaseMs?: number;
  now?: () => Date;
}

export interface RelayResult {
  published: number;
  failed: number;
  dead: number;
}

/**
 * Claims due pending events with FOR UPDATE SKIP LOCKED (safe with several relay instances), hands each to
 * `publish`, and records the outcome. Delivery is at-least-once: consumers must dedupe (see `processOnce`).
 */
export async function relayOutboxBatch(
  db: Db,
  publish: (event: EventEnvelope) => Promise<void>,
  options: RelayOptions = {},
): Promise<RelayResult> {
  const batchSize = options.batchSize ?? 50;
  const maxAttempts = options.maxAttempts ?? 8;
  const backoffBase = options.backoffBaseMs ?? 1_000;
  const now = options.now ?? (() => new Date());
  const result: RelayResult = { published: 0, failed: 0, dead: 0 };

  await systemTx(db, async (tx) => {
    const due = await tx
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.status, 'pending'), lte(outboxEvents.nextAttemptAt, now())))
      .orderBy(asc(outboxEvents.occurredAt), asc(outboxEvents.id))
      .limit(batchSize)
      .for('update', { skipLocked: true });

    const publishedIds: string[] = [];
    for (const row of due) {
      try {
        await publish(toEnvelope(row));
        publishedIds.push(row.id);
        result.published++;
      } catch (error) {
        const attempts = row.attempts + 1;
        const message = error instanceof Error ? error.message : String(error);
        if (attempts >= maxAttempts) {
          result.dead++;
          await tx
            .update(outboxEvents)
            .set({ status: 'dead', attempts, lastError: message.slice(0, 2000) })
            .where(eq(outboxEvents.id, row.id));
        } else {
          result.failed++;
          const delay = Math.min(backoffBase * 2 ** (attempts - 1), 15 * 60_000);
          await tx
            .update(outboxEvents)
            .set({
              attempts,
              lastError: message.slice(0, 2000),
              nextAttemptAt: new Date(now().getTime() + delay),
            })
            .where(eq(outboxEvents.id, row.id));
        }
      }
    }
    if (publishedIds.length) {
      await tx
        .update(outboxEvents)
        .set({
          status: 'published',
          publishedAt: now(),
          attempts: sql`${outboxEvents.attempts} + 1`,
          lastError: null,
        })
        .where(inArray(outboxEvents.id, publishedIds));
    }
  });
  return result;
}

/**
 * Idempotent consumer helper: runs `handler` and records (consumer, eventId) in one transaction.
 * Returns false when the event was already processed.
 */
export async function processOnce(
  db: Db,
  consumer: string,
  eventId: string,
  handler: (tx: Executor) => Promise<void>,
): Promise<boolean> {
  return systemTx(db, async (tx) => {
    const inserted = await tx
      .insert(processedEvents)
      .values({ consumer, eventId })
      .onConflictDoNothing()
      .returning({ eventId: processedEvents.eventId });
    if (inserted.length === 0) return false;
    await handler(tx);
    return true;
  });
}
