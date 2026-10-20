import { WEBHOOK_EVENT_TYPES } from '@uc/contracts';
import { deliverDueWebhooks, fanOutEvent, type Db } from '@uc/db';
import type { Logger } from 'pino';
import type { Consumer } from './consumers';

const DEV_SECRETS_KEY = 'dev-only-secrets-encryption-key-change-me-0123456';

/** Same rules as the API config: the development key and private targets are refused in production. */
export function webhookSettings(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === 'production';
  const secretsKey = env.SECRETS_ENCRYPTION_KEY ?? DEV_SECRETS_KEY;
  const allowPrivate = env.WEBHOOKS_ALLOW_PRIVATE_TARGETS === 'true';
  if (production && secretsKey === DEV_SECRETS_KEY)
    throw new Error('SECRETS_ENCRYPTION_KEY must be set in production');
  if (production && allowPrivate)
    throw new Error('WEBHOOKS_ALLOW_PRIVATE_TARGETS must be false in production');
  return { secretsKey, allowPrivate };
}

/** Phase 11: fans each tenant domain event out to subscribed webhook endpoints and matching automations. */
export function webhookFanoutConsumer(): Consumer {
  return {
    name: 'webhook-fanout',
    handles: WEBHOOK_EVENT_TYPES,
    async handle(event, tx) {
      await fanOutEvent(tx, event);
    },
  };
}

/** Delivers due webhooks every few seconds (signed, retried with backoff, dead after the attempt limit). */
export async function runWebhookLoop(
  db: Db,
  logger: Logger,
  signal: AbortSignal,
  everyMs = 3_000,
): Promise<void> {
  const settings = webhookSettings();
  while (!signal.aborted) {
    try {
      const r = await deliverDueWebhooks(db, settings);
      if (r.delivered || r.failed || r.dead) logger.info(r, 'webhook deliveries');
      if (r.dead) logger.error({ dead: r.dead }, 'webhook deliveries dead (replay from the admin)');
    } catch (error) {
      logger.error({ err: error }, 'webhook delivery loop failed');
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
