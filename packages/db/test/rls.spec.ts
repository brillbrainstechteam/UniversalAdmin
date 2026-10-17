import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit } from '../src/audit';
import { systemTx, tenantTx } from '../src/client';
import { auditEvents, locations, stores, tenants } from '../src/schema';
import { seedDemo, type SeedResult } from '../src/seed';
import { appDb, ownerPool } from './helpers';

/** Drizzle wraps driver errors; assert on the underlying Postgres message. */
async function expectDbError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e as { message: string; cause?: { message: string } },
  );
  expect(error, 'expected the query to fail').not.toBeNull();
  expect(error!.cause?.message ?? error!.message).toMatch(pattern);
}

const handle = appDb();
const owner = ownerPool();
let seed: SeedResult;

beforeAll(async () => {
  await owner.query('truncate tenants, users cascade');
  seed = await seedDemo(handle.db, 'TestPassword!2026');
});
afterAll(async () => {
  await handle.close();
  await owner.end();
});

describe('row-level security (F-02)', () => {
  it('returns zero tenant rows without a tenant context (fail closed)', async () => {
    const rows = await handle.db.select().from(stores);
    expect(rows).toHaveLength(0);
  });

  it('returns only the context tenant’s rows even when the query omits a tenant filter', async () => {
    const rows = await tenantTx(handle.db, seed.tenantIds.aurum, (tx) => tx.select().from(locations));
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.tenantId === seed.tenantIds.aurum)).toBe(true);
  });

  it('cannot read a foreign row by guessed id', async () => {
    const rows = await tenantTx(handle.db, seed.tenantIds.lumiere, (tx) =>
      tx.select().from(locations).where(eq(locations.id, seed.locationIds.aurumMumbai)),
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot update or delete foreign rows (silently affects 0 rows)', async () => {
    const updated = await tenantTx(handle.db, seed.tenantIds.lumiere, (tx) =>
      tx
        .update(locations)
        .set({ name: 'hijacked' })
        .where(eq(locations.id, seed.locationIds.aurumMumbai))
        .returning(),
    );
    expect(updated).toHaveLength(0);
    const deleted = await tenantTx(handle.db, seed.tenantIds.lumiere, (tx) =>
      tx.delete(locations).where(eq(locations.id, seed.locationIds.aurumJaipur)).returning(),
    );
    expect(deleted).toHaveLength(0);
    const still = await systemTx(handle.db, (tx) =>
      tx.select().from(locations).where(eq(locations.id, seed.locationIds.aurumMumbai)),
    );
    expect(still[0]?.name).toBe('Mumbai branch');
  });

  it('rejects inserting a row for another tenant (WITH CHECK)', async () => {
    await expectDbError(
      tenantTx(handle.db, seed.tenantIds.lumiere, (tx) =>
        tx.insert(stores).values({
          tenantId: seed.tenantIds.aurum,
          code: 'evil',
          name: 'Evil',
          defaultCurrency: 'INR',
          timezone: 'UTC',
        }),
      ),
      /row-level security/,
    );
  });

  it('tenant context is transaction-local and does not leak to the next pooled query', async () => {
    await tenantTx(handle.db, seed.tenantIds.aurum, async () => undefined);
    const rows = await handle.db.select().from(locations);
    expect(rows).toHaveLength(0);
  });

  it('rejects non-UUID tenant ids before touching the database', async () => {
    await expect(tenantTx(handle.db, "x' or 1=1 --", async () => undefined)).rejects.toThrow(/UUID/);
  });
});

describe('append-only audit log (F-04)', () => {
  it('runtime role can insert but not update or delete audit events', async () => {
    await tenantTx(handle.db, seed.tenantIds.aurum, (tx) =>
      writeAudit(tx, {
        tenantId: seed.tenantIds.aurum,
        actorType: 'system',
        actorUserId: null,
        action: 'test.event',
        entityType: 'test',
        newValues: { password: 'should-not-persist', note: 'ok' },
      }),
    );
    const [row] = await systemTx(handle.db, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, 'test.event')),
    );
    expect(row?.newValues).toEqual({ password: '[REDACTED]', note: 'ok' });
    await expectDbError(
      systemTx(handle.db, (tx) =>
        tx.update(auditEvents).set({ action: 'tampered' }).where(eq(auditEvents.id, row!.id)),
      ),
      /permission denied/,
    );
    await expectDbError(
      systemTx(handle.db, (tx) => tx.delete(auditEvents).where(eq(auditEvents.id, row!.id))),
      /permission denied/,
    );
  });

  it('even the owner role cannot mutate audit rows (trigger)', async () => {
    await expect(owner.query(`update audit_events set action = 'tampered'`)).rejects.toThrow(/append-only/);
    await expect(owner.query(`delete from audit_events`)).rejects.toThrow(/append-only/);
  });
});

describe('tenancy constraints', () => {
  it('codes are unique per tenant, not globally', async () => {
    // Every seeded tenant has a 'main' store.
    const rows = await systemTx(handle.db, (tx) => tx.select().from(stores).where(eq(stores.code, 'main')));
    expect(rows).toHaveLength(3);
  });

  it('cross-tenant references are rejected by composite foreign keys', async () => {
    const [lumiereStore] = await systemTx(handle.db, (tx) =>
      tx.select().from(stores).where(eq(stores.tenantId, seed.tenantIds.lumiere)),
    );
    await expectDbError(
      systemTx(handle.db, (tx) =>
        tx.insert(locations).values({
          tenantId: seed.tenantIds.aurum,
          storeId: lumiereStore!.id,
          code: 'x-ref',
          name: 'Cross',
          type: 'branch',
        }),
      ),
      /foreign key/,
    );
  });

  it('demo tenants are flagged', async () => {
    const rows = await systemTx(handle.db, (tx) => tx.select({ isDemo: tenants.isDemo }).from(tenants));
    expect(rows.every((r) => r.isDemo)).toBe(true);
    void sql;
  });
});
