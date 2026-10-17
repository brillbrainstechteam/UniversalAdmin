import { DOMAIN_EVENTS_QUEUE, type EventEnvelope } from '@uc/contracts';
import { relayOutboxBatch, type Db, type RelayResult } from '@uc/db';
import { Queue, type ConnectionOptions } from 'bullmq';
import type { Logger } from 'pino';

/** Publishes an envelope to BullMQ. jobId = eventId, so a re-published event is deduplicated by the queue. */
export function bullPublisher(queue: Queue) {
  return async (event: EventEnvelope): Promise<void> => {
    await queue.add(event.eventType, event, {
      jobId: event.eventId,
      attempts: 5,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: { age: 24 * 3600, count: 10_000 },
      removeOnFail: false, // failed jobs stay visible for operator review / replay
    });
  };
}

export function createDomainEventsQueue(connection: ConnectionOptions): Queue {
  return new Queue(DOMAIN_EVENTS_QUEUE, { connection });
}

/**
 * Polls the transactional outbox and relays due events. Loops until `signal` aborts.
 * Drains continuously while there is backlog; otherwise sleeps `idleMs`.
 */
export async function runRelayLoop(
  db: Db,
  publish: (e: EventEnvelope) => Promise<void>,
  logger: Logger,
  signal: AbortSignal,
  idleMs = 1_000,
): Promise<void> {
  while (!signal.aborted) {
    let result: RelayResult = { published: 0, failed: 0, dead: 0 };
    try {
      result = await relayOutboxBatch(db, publish);
      if (result.published || result.failed || result.dead) logger.info(result, 'outbox relay batch');
      if (result.dead) logger.error({ dead: result.dead }, 'outbox events moved to dead letter');
    } catch (error) {
      logger.error({ err: error }, 'outbox relay failed');
    }
    if (result.published === 0) await new Promise((r) => setTimeout(r, idleMs));
  }
}
