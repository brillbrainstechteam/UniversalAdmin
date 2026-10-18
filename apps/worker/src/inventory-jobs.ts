import { expireReservations, reconcileInventory, systemTx, type Db } from '@uc/db';
import type { Logger } from 'pino';

export interface InventoryJobOptions {
  /** How often due holds are expired (default 15 s). */
  expiryEveryMs?: number;
  /** How often balances are reconciled against the ledger, reservations and pieces (default 10 min). */
  reconcileEveryMs?: number;
}

/** One expiry pass across all tenants. Returns the number of holds expired. */
export async function runExpiryPass(db: Db, now = new Date()): Promise<number> {
  let total = 0;
  // Batches of 500; stop when a batch is not full.
  for (;;) {
    const n = await systemTx(db, (tx) => expireReservations(tx, { now, limit: 500 }));
    total += n;
    if (n < 500) return total;
  }
}

export async function runReconcilePass(db: Db) {
  return systemTx(db, (tx) => reconcileInventory(tx));
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

/**
 * Background inventory maintenance (ADR-018): expire due holds (reservations also expire inline on the next
 * reserve for the same variant, so stock is never stuck while the worker is down) and periodic reconciliation.
 * Errors are logged and retried on the next tick; a failing pass never stops the loop.
 */
export async function runInventoryLoops(
  db: Db,
  logger: Logger,
  signal: AbortSignal,
  options: InventoryJobOptions = {},
) {
  const expiryEvery = options.expiryEveryMs ?? 15_000;
  const reconcileEvery = options.reconcileEveryMs ?? 10 * 60_000;
  let nextReconcile = Date.now() + 60_000;
  while (!signal.aborted) {
    try {
      const expired = await runExpiryPass(db);
      if (expired) logger.info({ expired }, 'reservations expired');
    } catch (error) {
      logger.error({ err: error }, 'reservation expiry failed');
    }
    if (Date.now() >= nextReconcile) {
      nextReconcile = Date.now() + reconcileEvery;
      try {
        const result = await runReconcilePass(db);
        if (result.mismatches) logger.warn(result, 'inventory reconciliation found mismatches');
        else logger.info(result, 'inventory reconciliation clean');
      } catch (error) {
        logger.error({ err: error }, 'inventory reconciliation failed');
      }
    }
    await sleep(expiryEvery, signal);
  }
}
