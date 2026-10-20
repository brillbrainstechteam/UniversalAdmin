import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  AutomationAction,
  AutomationConditions,
  WEBHOOK_EVENT_TYPES,
  type EventEnvelope,
} from '@uc/contracts';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { systemTx, type Db, type Executor } from './client';
import {
  automationRuns,
  automations,
  staffNotifications,
  webhookDeliveries,
  webhookEndpoints,
} from './ops-schema';
import { orders } from './orders-schema';
import { decryptSecret } from './secrets';

/** Phase 11 outbound webhooks and automations (ADR-026). */
export const WEBHOOK_MAX_ATTEMPTS = 8;
const LEASE_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;

/** Retry delay after the n-th failed attempt: 30 s × 2^(n−1), capped at 6 h. */
export function webhookBackoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 6 * 3600_000);
}

export function webhookBody(event: EventEnvelope): Record<string, unknown> {
  return {
    id: event.eventId,
    type: event.eventType,
    occurredAt: event.occurredAt,
    tenantId: event.tenantId,
    data: event.payload,
  };
}

/** `X-UC-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`. */
export function signWebhook(secret: string, body: string, unixSeconds: number): string {
  return `t=${unixSeconds},v1=${createHmac('sha256', secret).update(`${unixSeconds}.${body}`).digest('hex')}`;
}

function privateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::' || v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd'))
      return true;
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return mapped ? privateAddress(mapped[1]!) : false;
  }
  const [a, b] = ip.split('.').map((x) => Number.parseInt(x, 10)) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/**
 * Refuses URLs that are not https or that resolve to private, loopback, link-local or metadata addresses (SSRF).
 * `allowPrivate` exists for local development and tests only (the API refuses it in production).
 */
export async function assertPublicUrl(raw: string, allowPrivate: boolean): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Not a valid URL');
  }
  if (url.username || url.password) throw new Error('URLs with credentials are not allowed');
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:'))
    throw new Error('Only https:// URLs are allowed');
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addresses.length || addresses.some(privateAddress))
    throw new Error('The URL points to a private or internal address');
}

/**
 * Consumer side of a domain event: one delivery per subscribed active endpoint, then automations whose trigger
 * matches. Automation actions never emit domain events, so automations cannot trigger each other.
 */
export async function fanOutEvent(tx: Executor, event: EventEnvelope, now = new Date()): Promise<void> {
  if (!event.tenantId || !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(event.eventType)) return;
  const tenantId = event.tenantId;
  const endpoints = await tx
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.tenantId, tenantId),
        eq(webhookEndpoints.status, 'active'),
        sql`${event.eventType} = any(${webhookEndpoints.eventTypes})`,
      ),
    );
  if (endpoints.length)
    await tx
      .insert(webhookDeliveries)
      .values(
        endpoints.map((e) => ({
          tenantId,
          endpointId: e.id,
          eventId: event.eventId,
          eventType: event.eventType,
          payload: webhookBody(event),
          source: 'event' as const,
          nextAttemptAt: now,
        })),
      )
      .onConflictDoNothing();

  const rules = await tx
    .select()
    .from(automations)
    .where(
      and(
        eq(automations.tenantId, tenantId),
        eq(automations.trigger, event.eventType),
        eq(automations.status, 'active'),
      ),
    );
  if (!rules.length) return;
  const orderId = typeof event.payload.orderId === 'string' ? event.payload.orderId : null;
  const [order] = orderId
    ? await tx
        .select({ total: orders.totalMinor, channelId: orders.channelId, number: orders.number })
        .from(orders)
        .where(eq(orders.id, orderId))
    : [];
  for (const rule of rules) {
    const cond = AutomationConditions.parse(rule.conditions);
    const action = AutomationAction.parse(rule.action);
    let outcome: 'done' | 'skipped' | 'failed' = 'done';
    let detail: string | null = null;
    if ((cond.minOrderTotalMinor !== null || cond.channelId !== null) && !order) {
      outcome = 'skipped';
      detail = 'The event is not about an order';
    } else if (cond.minOrderTotalMinor !== null && order!.total < BigInt(cond.minOrderTotalMinor)) {
      outcome = 'skipped';
      detail = `Order total ${order!.total.toString()} is below ${cond.minOrderTotalMinor}`;
    } else if (cond.channelId !== null && order!.channelId !== cond.channelId) {
      outcome = 'skipped';
      detail = 'Different channel';
    } else if (action.type === 'webhook') {
      const [ep] = await tx
        .select({ id: webhookEndpoints.id, status: webhookEndpoints.status })
        .from(webhookEndpoints)
        .where(and(eq(webhookEndpoints.id, action.endpointId), eq(webhookEndpoints.tenantId, tenantId)));
      if (!ep || ep.status !== 'active') {
        outcome = 'failed';
        detail = 'The webhook endpoint is missing or disabled';
      } else {
        await tx
          .insert(webhookDeliveries)
          .values({
            tenantId,
            endpointId: ep.id,
            eventId: event.eventId,
            eventType: event.eventType,
            payload: { ...webhookBody(event), automation: { id: rule.id, name: rule.name } },
            source: 'automation',
            nextAttemptAt: now,
          })
          .onConflictDoNothing();
        detail = 'Queued for webhook delivery';
      }
    } else {
      await tx.insert(staffNotifications).values({
        tenantId,
        title: action.title,
        body: `${event.eventType}${order ? ` · order ${order.number}` : ''}`,
        link: orderId ? `/orders/${orderId}` : null,
        source: `automation:${rule.name}`,
        createdAt: now,
      });
      detail = 'Staff notified';
    }
    await tx
      .insert(automationRuns)
      .values({ tenantId, automationId: rule.id, eventId: event.eventId, outcome, detail, createdAt: now })
      .onConflictDoNothing();
  }
}

export interface DeliverOptions {
  secretsKey: string;
  allowPrivate: boolean;
  now?: Date;
  limit?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Delivers due webhooks. Rows are leased (next attempt pushed out) in a short transaction with SKIP LOCKED, so
 * concurrent workers never send the same delivery twice; the HTTP call happens outside any transaction.
 */
export async function deliverDueWebhooks(
  db: Db,
  opts: DeliverOptions,
): Promise<{ delivered: number; failed: number; dead: number }> {
  const now = opts.now ?? new Date();
  const doFetch = opts.fetchImpl ?? fetch;
  const claimed = await systemTx(db, async (tx) => {
    const due = await tx
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(
        and(
          inArray(webhookDeliveries.status, ['pending', 'failed']),
          lte(webhookDeliveries.nextAttemptAt, now),
        ),
      )
      .orderBy(webhookDeliveries.nextAttemptAt)
      .limit(opts.limit ?? 50)
      .for('update', { skipLocked: true });
    if (!due.length) return [];
    return tx
      .update(webhookDeliveries)
      .set({ nextAttemptAt: new Date(now.getTime() + LEASE_MS) })
      .where(
        inArray(
          webhookDeliveries.id,
          due.map((d) => d.id),
        ),
      )
      .returning();
  });
  const result = { delivered: 0, failed: 0, dead: 0 };
  for (const d of claimed) {
    const [ep] = await systemTx(db, (tx) =>
      tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, d.endpointId)),
    );
    let code: number | null = null;
    let error: string | null = null;
    if (!ep || ep.status !== 'active') error = 'Endpoint disabled';
    else {
      try {
        await assertPublicUrl(ep.url, opts.allowPrivate);
        const body = JSON.stringify(d.payload);
        const res = await doFetch(ep.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'UniversalCommerce-Webhooks/1',
            'X-UC-Event-Id': d.eventId,
            'X-UC-Event-Type': d.eventType,
            'X-UC-Delivery-Id': d.id,
            'X-UC-Signature': signWebhook(
              decryptSecret(ep.secretSealed, opts.secretsKey),
              body,
              Math.floor(now.getTime() / 1000),
            ),
          },
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        code = res.status;
        if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
      } catch (e) {
        error =
          (e as Error).name === 'TimeoutError' ? 'Timed out after 10 s' : (e as Error).message.slice(0, 300);
      }
    }
    const attempts = d.attempts + 1;
    await systemTx(db, async (tx) => {
      if (!error) {
        await tx
          .update(webhookDeliveries)
          .set({ status: 'delivered', attempts, lastStatusCode: code, lastError: null, deliveredAt: now })
          .where(eq(webhookDeliveries.id, d.id));
        await tx
          .update(webhookEndpoints)
          .set({ consecutiveFailures: 0, lastSuccessAt: now })
          .where(eq(webhookEndpoints.id, d.endpointId));
        result.delivered++;
      } else {
        const dead = attempts >= WEBHOOK_MAX_ATTEMPTS;
        await tx
          .update(webhookDeliveries)
          .set({
            status: dead ? 'dead' : 'failed',
            attempts,
            lastStatusCode: code,
            lastError: error,
            nextAttemptAt: new Date(now.getTime() + webhookBackoffMs(attempts)),
          })
          .where(eq(webhookDeliveries.id, d.id));
        if (ep)
          await tx
            .update(webhookEndpoints)
            .set({
              consecutiveFailures: sql`${webhookEndpoints.consecutiveFailures} + 1`,
              lastFailureAt: now,
            })
            .where(eq(webhookEndpoints.id, d.endpointId));
        if (dead) result.dead++;
        else result.failed++;
      }
    });
  }
  return result;
}
