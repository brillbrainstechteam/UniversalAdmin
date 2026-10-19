import { ADAPTERS } from '@uc/connector-sdk';
import { relayOutboundCommands, type Db, type OrderPushAdapter } from '@uc/db';
import type { Logger } from 'pino';

/** One relay pass: sends due ERP order-export commands through their adapters (ADR-019). */
export function runOutboundPass(db: Db, options: { backoffBaseMs?: number; now?: () => Date } = {}) {
  return relayOutboundCommands(db, ADAPTERS as Record<string, OrderPushAdapter>, {
    ...options,
    // Order export never needs piece data; keep the simulator's derived flag out of persisted state.
    stateOf: () => ({ pieces: false }),
  });
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
 * Background order export to ERPs. Failures retry with exponential backoff and end as `failed` exceptions that a
 * person retries from the admin; a failing pass never stops the loop.
 */
export async function runIntegrationLoops(db: Db, logger: Logger, signal: AbortSignal, everyMs = 5_000) {
  while (!signal.aborted) {
    try {
      const r = await runOutboundPass(db);
      if (r.acknowledged || r.retrying || r.failed) logger.info(r, 'outbound order export pass');
      if (r.failed) logger.warn({ failed: r.failed }, 'outbound commands failed and need attention');
    } catch (error) {
      logger.error({ err: error }, 'outbound relay failed');
    }
    await sleep(everyMs, signal);
  }
}
