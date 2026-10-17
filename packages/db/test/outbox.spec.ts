import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { systemTx } from '../src/client';
import { enqueueEvent, processOnce, relayOutboxBatch } from '../src/outbox';
import { diff, redact } from '../src/redact';
import { outboxEvents } from '../src/schema';
import { appDb, ownerPool } from './helpers';

const handle = appDb();
const owner = ownerPool();
beforeEach(async () => {
  await owner.query('delete from outbox_events');
  await owner.query('delete from processed_events');
});
afterAll(async () => {
  await handle.close();
  await owner.end();
});

const event = {
  tenantId: null,
  eventType: 'TenantProvisioned' as const,
  aggregateType: 'tenant',
  aggregateId: 't1',
  payload: { a: 1 },
};

describe('transactional outbox (F-07, F-08)', () => {
  it('event is persisted only if the business transaction commits', async () => {
    await expect(
      systemTx(handle.db, async (tx) => {
        await enqueueEvent(tx, event);
        throw new Error('business failure');
      }),
    ).rejects.toThrow('business failure');
    expect(await handle.db.select().from(outboxEvents)).toHaveLength(0);

    await systemTx(handle.db, (tx) => enqueueEvent(tx, event));
    const rows = await systemTx(handle.db, (tx) => tx.select().from(outboxEvents));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('pending');
  });

  it('relay publishes the contract envelope and marks events published', async () => {
    const id = await systemTx(handle.db, (tx) => enqueueEvent(tx, { ...event, correlationId: 'corr-123' }));
    const published: unknown[] = [];
    const result = await relayOutboxBatch(handle.db, async (e) => void published.push(e));
    expect(result).toEqual({ published: 1, failed: 0, dead: 0 });
    expect(published[0]).toMatchObject({
      eventId: id,
      eventType: 'TenantProvisioned',
      eventVersion: 1,
      correlationId: 'corr-123',
      payload: { a: 1 },
    });
    const [row] = await systemTx(handle.db, (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.id, id)),
    );
    expect(row?.status).toBe('published');
    // Nothing left to publish.
    expect(await relayOutboxBatch(handle.db, async () => undefined)).toEqual({
      published: 0,
      failed: 0,
      dead: 0,
    });
  });

  it('failed publishes back off exponentially and dead-letter after max attempts', async () => {
    const id = await systemTx(handle.db, (tx) => enqueueEvent(tx, event));
    let clock = new Date('2030-01-01T00:00:00Z');
    const fail = async () => {
      throw new Error('broker down');
    };
    const r1 = await relayOutboxBatch(handle.db, fail, {
      maxAttempts: 3,
      backoffBaseMs: 1000,
      now: () => clock,
    });
    expect(r1.failed).toBe(1);
    let [row] = await systemTx(handle.db, (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.id, id)),
    );
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt.getTime()).toBe(clock.getTime() + 1000);
    // Not due yet: untouched.
    expect((await relayOutboxBatch(handle.db, fail, { maxAttempts: 3, now: () => clock })).failed).toBe(0);
    clock = new Date(clock.getTime() + 1000);
    await relayOutboxBatch(handle.db, fail, { maxAttempts: 3, backoffBaseMs: 1000, now: () => clock });
    [row] = await systemTx(handle.db, (tx) => tx.select().from(outboxEvents).where(eq(outboxEvents.id, id)));
    expect(row?.nextAttemptAt.getTime()).toBe(clock.getTime() + 2000);
    clock = new Date(clock.getTime() + 2000);
    const r3 = await relayOutboxBatch(handle.db, fail, { maxAttempts: 3, now: () => clock });
    expect(r3.dead).toBe(1);
    [row] = await systemTx(handle.db, (tx) => tx.select().from(outboxEvents).where(eq(outboxEvents.id, id)));
    expect(row).toMatchObject({ status: 'dead', attempts: 3, lastError: 'broker down' });
  });

  it('concurrent relays never publish the same event twice (SKIP LOCKED)', async () => {
    for (let i = 0; i < 20; i++)
      await systemTx(handle.db, (tx) => enqueueEvent(tx, { ...event, aggregateId: `t${i}` }));
    const seen: string[] = [];
    const publish = async (e: { eventId: string }) => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(e.eventId);
    };
    await Promise.all([
      relayOutboxBatch(handle.db, publish, { batchSize: 7 }),
      relayOutboxBatch(handle.db, publish, { batchSize: 7 }),
      relayOutboxBatch(handle.db, publish, { batchSize: 7 }),
    ]);
    while ((await relayOutboxBatch(handle.db, publish)).published > 0);
    expect(seen).toHaveLength(20);
    expect(new Set(seen).size).toBe(20);
  });

  it('idempotent consumer processes an event once per consumer', async () => {
    let runs = 0;
    const eventId = '11111111-1111-4111-8111-111111111111';
    expect(await processOnce(handle.db, 'c1', eventId, async () => void runs++)).toBe(true);
    expect(await processOnce(handle.db, 'c1', eventId, async () => void runs++)).toBe(false);
    expect(await processOnce(handle.db, 'c2', eventId, async () => void runs++)).toBe(true);
    expect(runs).toBe(2);
  });

  it('a failing consumer does not record the event as processed (retry possible)', async () => {
    const eventId = '22222222-2222-4222-8222-222222222222';
    await expect(
      processOnce(handle.db, 'c1', eventId, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await processOnce(handle.db, 'c1', eventId, async () => undefined)).toBe(true);
  });
});

describe('redaction', () => {
  it('redacts sensitive keys at any depth', () => {
    expect(
      redact({ email: 'a@b.c', password: 'x', nested: { apiKey: 'k', tokenHash: 'h', ok: [{ secret: 1 }] } }),
    ).toEqual({
      email: 'a@b.c',
      password: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', tokenHash: '[REDACTED]', ok: [{ secret: '[REDACTED]' }] },
    });
  });
  it('diff keeps only changed keys and ignores version/updatedAt', () => {
    expect(
      diff({ a: 1, b: 2, version: 1, updatedAt: 'x' }, { a: 1, b: 3, version: 2, updatedAt: 'y' }),
    ).toEqual({
      oldValues: { b: 2 },
      newValues: { b: 3 },
    });
  });
});
