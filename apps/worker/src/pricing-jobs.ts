import { flagStaleRates, systemTx, type Db } from '@uc/db';
import type { Logger } from 'pino';

/** One staleness pass across all tenants: emits RateStale once per current rate older than the tenant's max age. */
export async function runStaleRatePass(db: Db, now = new Date()): Promise<number> {
  return systemTx(db, (tx) => flagStaleRates(tx, now));
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
 * Rate freshness monitor (ADR-021). Quotes check freshness themselves on every calculation; this loop only makes
 * staleness visible (RateStale events) even when nobody is quoting. Errors are logged and retried next tick.
 */
export async function runPricingLoops(db: Db, logger: Logger, signal: AbortSignal, everyMs = 60_000) {
  while (!signal.aborted) {
    try {
      const n = await runStaleRatePass(db);
      if (n) logger.warn({ staleRates: n }, 'metal rates became stale');
    } catch (error) {
      logger.error({ err: error }, 'stale rate check failed');
    }
    await sleep(everyMs, signal);
  }
}
