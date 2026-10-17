import { DOMAIN_EVENTS_QUEUE, EventEnvelope, type DomainEventType } from '@uc/contracts';
import { processOnce, type Db, type Executor } from '@uc/db';
import { Worker, type ConnectionOptions } from 'bullmq';
import type { Logger } from 'pino';

export interface Consumer {
  /** Stable name; part of the dedupe key, never rename. */
  name: string;
  handles: readonly DomainEventType[];
  handle(event: EventEnvelope, tx: Executor): Promise<void>;
}

/**
 * Phase 01 consumer: structured operational log of lifecycle events. Real projections/integrations register here
 * in later phases (e.g. cache invalidation on TenantEntitlementsChanged, ERP order export).
 */
export function lifecycleLogConsumer(logger: Logger): Consumer {
  return {
    name: 'lifecycle-log',
    handles: [
      'TenantProvisioned',
      'TenantSuspended',
      'TenantReactivated',
      'TenantEntitlementsChanged',
      'MembershipChanged',
    ],
    async handle(event) {
      logger.info(
        {
          eventId: event.eventId,
          eventType: event.eventType,
          tenantId: event.tenantId,
          correlationId: event.correlationId,
        },
        'domain event',
      );
    },
  };
}

/** Dispatches one envelope to every interested consumer exactly once per (consumer, eventId). */
export async function dispatch(db: Db, consumers: Consumer[], raw: unknown): Promise<string[]> {
  const event = EventEnvelope.parse(raw);
  const processedBy: string[] = [];
  for (const consumer of consumers) {
    if (!consumer.handles.includes(event.eventType)) continue;
    const ran = await processOnce(db, consumer.name, event.eventId, (tx) => consumer.handle(event, tx));
    if (ran) processedBy.push(consumer.name);
  }
  return processedBy;
}

export function startConsumerWorker(
  db: Db,
  consumers: Consumer[],
  connection: ConnectionOptions,
  logger: Logger,
): Worker {
  const worker = new Worker(DOMAIN_EVENTS_QUEUE, (job) => dispatch(db, consumers, job.data), {
    connection,
    concurrency: 5,
  });
  worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'domain event consumer failed'));
  return worker;
}
