import { createDb, requireEnv } from '@uc/db';
import pino from 'pino';
import { lifecycleLogConsumer, startConsumerWorker } from './consumers';
import { runIntegrationLoops } from './integration-jobs';
import { runInventoryLoops } from './inventory-jobs';
import { runOrderLoops } from './order-jobs';
import { runPricingLoops } from './pricing-jobs';
import { bullPublisher, createDomainEventsQueue, runRelayLoop } from './relay';

async function main(): Promise<void> {
  const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'uc-worker' } });
  const db = createDb(requireEnv('DATABASE_URL'), { max: 5, appName: 'uc-worker' });
  const redisUrl = new URL(requireEnv('REDIS_URL'));
  const connection = {
    host: redisUrl.hostname,
    port: Number(redisUrl.port || 6379),
    maxRetriesPerRequest: null,
  };

  const queue = createDomainEventsQueue(connection);
  const worker = startConsumerWorker(db.db, [lifecycleLogConsumer(logger)], connection, logger);
  const controller = new AbortController();
  const relay = runRelayLoop(db.db, bullPublisher(queue), logger, controller.signal);
  const inventory = runInventoryLoops(db.db, logger, controller.signal);
  const integrations = runIntegrationLoops(db.db, logger, controller.signal);
  const pricing = runPricingLoops(db.db, logger, controller.signal);
  const orderLoops = runOrderLoops(db.db, logger, controller.signal);
  logger.info(
    'worker started: outbox relay + domain-events consumers + inventory expiry/reconciliation + ERP order export + rate staleness + order expiry',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    controller.abort();
    await relay;
    await inventory;
    await integrations;
    await pricing;
    await orderLoops;
    await worker.close();
    await queue.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
