import {
  createDb,
  postMovements,
  products,
  provisionTenantRecords,
  requireEnv,
  reserveStock,
  resetSchema,
  runMigrations,
  systemTx,
  variants,
} from '@uc/db';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runExpiryPass, runReconcilePass } from '../src/inventory-jobs';

const handle = createDb(requireEnv('TEST_DATABASE_URL'), { max: 3 });
const owner = new Pool({ connectionString: requireEnv('TEST_DATABASE_OWNER_URL'), max: 2 });
let tenantId: string;
let locationId: string;
let variantId: string;

beforeAll(async () => {
  await resetSchema(requireEnv('TEST_DATABASE_OWNER_URL'));
  await runMigrations(requireEnv('TEST_DATABASE_OWNER_URL'));
  const p = await systemTx(handle.db, (tx) =>
    provisionTenantRecords(tx, {
      slug: 'inv-worker',
      displayName: 'Inventory worker test (DEMO)',
      legalName: 'Inventory worker test',
      preset: 'general_commerce',
      countryCode: 'IN',
      defaultCurrency: 'INR',
      timezone: 'Asia/Kolkata',
      defaultLocale: 'en-IN',
      contactEmail: null,
      isDemo: true,
    }),
  );
  tenantId = p.tenant.id;
  locationId = p.locationId;
  variantId = await systemTx(handle.db, async (tx) => {
    const [product] = await tx
      .insert(products)
      .values({ tenantId, title: 'Worker mug', slug: 'worker-mug' })
      .returning({ id: products.id });
    const [variant] = await tx
      .insert(variants)
      .values({ tenantId, productId: product!.id, sku: 'WRK-MUG' })
      .returning({ id: variants.id });
    await postMovements(tx, {
      tenantId,
      type: 'receipt',
      actorUserId: null,
      lines: [{ variantId: variant!.id, locationId, condition: 'sellable', onHand: '3' }],
    });
    return variant!.id;
  });
});
afterAll(async () => {
  await handle.close();
  await owner.end();
});

const reserved = async () =>
  (
    await owner.query(
      "select reserved from stock_balances where variant_id = $1 and condition = 'sellable'",
      [variantId],
    )
  ).rows[0].reserved as string;

describe('inventory background jobs (I-02, I-03)', () => {
  it('expires due holds across tenants exactly once', async () => {
    const holds = await systemTx(handle.db, async (tx) => [
      (
        await reserveStock(tx, {
          tenantId,
          variantId,
          quantity: '1',
          referenceType: 'cart',
          idempotencyKey: 'worker-hold-1',
          actorUserId: null,
          allowedLocationIds: null,
        })
      ).reservation,
      (
        await reserveStock(tx, {
          tenantId,
          variantId,
          quantity: '1',
          referenceType: 'cart',
          idempotencyKey: 'worker-hold-2',
          actorUserId: null,
          allowedLocationIds: null,
        })
      ).reservation,
    ]);
    expect(await reserved()).toBe('2.000000');
    await owner.query("update reservations set expires_at = now() - interval '1 minute' where id = $1", [
      holds[0]!.id,
    ]);
    expect(await runExpiryPass(handle.db)).toBe(1);
    expect(await runExpiryPass(handle.db)).toBe(0);
    expect(await reserved()).toBe('1.000000');
    const statuses = await owner.query('select id, status from reservations order by idempotency_key');
    expect(statuses.rows.map((r) => r.status)).toEqual(['expired', 'held']);
  });

  it('reconciliation is clean on a consistent ledger and reports tampering once', async () => {
    expect(await runReconcilePass(handle.db)).toMatchObject({ mismatches: 0, issuesOpened: 0 });
    await owner.query('update stock_balances set reserved = reserved + 1 where variant_id = $1', [variantId]);
    const first = await runReconcilePass(handle.db);
    // Ledger sum and open reservations both disagree with the tampered balance.
    expect(first).toMatchObject({ mismatches: 2, issuesOpened: 2 });
    expect(await runReconcilePass(handle.db)).toMatchObject({ mismatches: 2, issuesOpened: 0 });
    const kinds = await owner.query("select details->>'check' c from reconciliation_issues order by 1");
    expect(kinds.rows.map((r) => r.c)).toEqual(['ledger', 'reservations']);
  });
});
