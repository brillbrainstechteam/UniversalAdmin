import { expireOrders, expireQuotations, systemTx, type Db } from '@uc/db';
import type { Logger } from 'pino';

/** One pass: cancel unpaid / unapproved orders past their window (stock released), expire lapsed quotations. */
export async function runOrderExpiryPass(db: Db, now = new Date()) {
  const orders = await systemTx(db, (tx) => expireOrders(tx, now));
  const quotations = await systemTx(db, (tx) => expireQuotations(tx, now));
  return { orders, quotations };
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
 * Order timeouts (ADR-022). Holds also expire on their own (inventory loop), so stock is never stuck; this loop
 * closes the orders and quotations themselves. Errors are logged and retried on the next tick.
 */
export async function runOrderLoops(db: Db, logger: Logger, signal: AbortSignal, everyMs = 30_000) {
  while (!signal.aborted) {
    try {
      const r = await runOrderExpiryPass(db);
      if (r.orders || r.quotations) logger.info(r, 'orders/quotations expired');
    } catch (error) {
      logger.error({ err: error }, 'order expiry failed');
    }
    await sleep(everyMs, signal);
  }
}
