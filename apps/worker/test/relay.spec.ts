import { DOMAIN_EVENTS_QUEUE } from '@uc/contracts';
import {
  createDb,
  enqueueEvent,
  relayOutboxBatch,
  requireEnv,
  resetSchema,
  runMigrations,
  systemTx,
} from '@uc/db';
import { Queue, QueueEvents } from 'bullmq';
import { Pool } from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dispatch, startConsumerWorker, type Consumer } from '../src/consumers';
import { bullPublisher } from '../src/relay';

const redisUrl = new URL(requireEnv('REDIS_URL'));
// Redis logical DB 2: isolated from dev (0) and API tests (1).
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port),
  db: 2,
  maxRetriesPerRequest: null,
};
const handle = createDb(requireEnv('TEST_DATABASE_URL'), { max: 5 });
const owner = new Pool({ connectionString: requireEnv('TEST_DATABASE_OWNER_URL'), max: 2 });
const logger = pino({ level: 'silent' });
let queue: Queue;

beforeAll(async () => {
  await resetSchema(requireEnv('TEST_DATABASE_OWNER_URL'));
  await runMigrations(requireEnv('TEST_DATABASE_OWNER_URL'));
  queue = new Queue(DOMAIN_EVENTS_QUEUE, { connection });
});
beforeEach(async () => {
  await queue.obliterate({ force: true });
  await owner.query('delete from outbox_events; delete from processed_events');
});
afterAll(async () => {
  await queue.close();
  await handle.close();
  await owner.end();
});

const event = {
  tenantId: null,
  eventType: 'TenantProvisioned' as const,
  aggregateType: 'tenant',
  aggregateId: 't-1',
  payload: { slug: 'x' },
};

describe('outbox → BullMQ relay (F-08)', () => {
  it('publishes each event as a job whose id is the event id', async () => {
    const id = await systemTx(handle.db, (tx) => enqueueEvent(tx, event));
    expect(await relayOutboxBatch(handle.db, bullPublisher(queue))).toEqual({
      published: 1,
      failed: 0,
      dead: 0,
    });
    const job = await queue.getJob(id);
    expect(job?.name).toBe('TenantProvisioned');
    expect(job?.data).toMatchObject({ eventId: id, eventType: 'TenantProvisioned', payload: { slug: 'x' } });
  });

  it('re-publishing after a crash between publish and commit does not create a duplicate job', async () => {
    const id = await systemTx(handle.db, (tx) => enqueueEvent(tx, event));
    await relayOutboxBatch(handle.db, bullPublisher(queue));
    // Simulate the relay crashing before it recorded the publish.
    await owner.query(`update outbox_events set status = 'pending' where id = $1`, [id]);
    await relayOutboxBatch(handle.db, bullPublisher(queue));
    const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'delayed');
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('keeps events pending with backoff while Redis is unreachable', async () => {
    const id = await systemTx(handle.db, (tx) => enqueueEvent(tx, event));
    const dead = new Queue(DOMAIN_EVENTS_QUEUE, {
      connection: {
        host: '127.0.0.1',
        port: 1,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
        connectTimeout: 200,
      },
    });
    dead.on('error', () => undefined);
    try {
      const result = await relayOutboxBatch(handle.db, bullPublisher(dead));
      expect(result.failed).toBe(1);
    } finally {
      await dead.close().catch(() => undefined);
    }
    const { rows } = await owner.query(
      'select status, attempts, last_error from outbox_events where id = $1',
      [id],
    );
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(rows[0].last_error).toBeTruthy();
  });
});

describe('domain event consumers', () => {
  it('a worker consumes relayed events exactly once per consumer, even when redelivered', async () => {
    const handled: string[] = [];
    const consumer: Consumer = {
      name: 'test-consumer',
      handles: ['TenantProvisioned'],
      handle: async (e) => void handled.push(e.eventId),
    };
    const worker = startConsumerWorker(handle.db, [consumer], connection, logger);
    const events = new QueueEvents(DOMAIN_EVENTS_QUEUE, { connection });
    try {
      const id = await systemTx(handle.db, (tx) => enqueueEvent(tx, event));
      const done = new Promise<void>((resolve) =>
        events.on('completed', ({ jobId }) => jobId === id && resolve()),
      );
      await events.waitUntilReady();
      await relayOutboxBatch(handle.db, bullPublisher(queue));
      await done;
      expect(handled).toEqual([id]);
      // At-least-once redelivery of the same envelope is a no-op.
      const job = await queue.getJob(id);
      expect(await dispatch(handle.db, [consumer], job!.data)).toEqual([]);
      expect(handled).toEqual([id]);
    } finally {
      await worker.close();
      await events.close();
    }
  });

  it('rejects payloads that do not match the event envelope contract', async () => {
    await expect(dispatch(handle.db, [], { eventType: 'TenantProvisioned' })).rejects.toThrow();
  });
});
