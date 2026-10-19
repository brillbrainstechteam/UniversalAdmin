import { and, asc, eq, lte } from 'drizzle-orm';
import type { Db } from './client';
import { systemTx } from './client';
import { connections, outboundCommands } from './integrations-schema';
import { enqueueEvent } from './outbox';

/** The part of a connector adapter the relay needs (kept local so the db package does not depend on the SDK). */
export interface OrderPushAdapter {
  pushOrder?(
    state: never,
    command: { reference: string; payload: Record<string, unknown> },
  ): Promise<{ state: unknown; externalRef?: string; error?: Error & { maybeAccepted?: boolean } }>;
}

export interface OutboundRelayOptions {
  batchSize?: number;
  maxAttempts?: number;
  /** delay = base × 2^(attempts−1), capped at 30 minutes. */
  backoffBaseMs?: number;
  now?: () => Date;
  /** Extra adapter state per connection (e.g. tenant feature flags); merged before calling the adapter. */
  stateOf?: (connection: typeof connections.$inferSelect) => Record<string, unknown>;
}

export interface OutboundRelayResult {
  acknowledged: number;
  retrying: number;
  failed: number;
}

/**
 * Sends due outbound commands (ERP order export) through their connector adapter. Commands are claimed with
 * SKIP LOCKED, the connection row is locked while its adapter state changes, and every command carries a stable
 * reference so a retry after a timeout cannot create a second ERP order (specs/05 "reservation/order export race").
 * Exhausted commands become `failed` operational exceptions — never marked as accepted.
 */
export async function relayOutboundCommands(
  db: Db,
  adapters: Record<string, OrderPushAdapter>,
  options: OutboundRelayOptions = {},
): Promise<OutboundRelayResult> {
  const now = options.now ?? (() => new Date());
  const maxAttempts = options.maxAttempts ?? 5;
  const base = options.backoffBaseMs ?? 5_000;
  const result: OutboundRelayResult = { acknowledged: 0, retrying: 0, failed: 0 };

  await systemTx(db, async (tx) => {
    const due = await tx
      .select()
      .from(outboundCommands)
      .where(and(eq(outboundCommands.status, 'pending'), lte(outboundCommands.nextAttemptAt, now())))
      .orderBy(asc(outboundCommands.nextAttemptAt), asc(outboundCommands.id))
      .limit(options.batchSize ?? 20)
      .for('update', { skipLocked: true });

    for (const cmd of due) {
      const [conn] = await tx
        .select()
        .from(connections)
        .where(eq(connections.id, cmd.connectionId))
        .for('update');
      const adapter = conn ? adapters[conn.connectorKey] : undefined;
      const fail = async (message: string) => {
        result.failed++;
        await tx
          .update(outboundCommands)
          .set({
            status: 'failed',
            attempts: cmd.attempts + 1,
            lastError: message.slice(0, 2000),
            nextAttemptAt: null,
          })
          .where(eq(outboundCommands.id, cmd.id));
        await enqueueEvent(tx, {
          tenantId: cmd.tenantId,
          eventType: 'OrderExportFailed',
          aggregateType: 'outbound_command',
          aggregateId: cmd.id,
          payload: { reference: cmd.reference, connectionId: cmd.connectionId, error: message.slice(0, 500) },
        });
      };
      if (!conn || conn.status !== 'active') {
        await fail(conn ? `Connection is ${conn.status}` : 'Connection no longer exists');
        continue;
      }
      if (!adapter?.pushOrder) {
        await fail(`Connector ${conn.connectorKey} cannot push orders`);
        continue;
      }
      const state = { ...(conn.adapterState as Record<string, unknown>), ...(options.stateOf?.(conn) ?? {}) };
      let outcome: Awaited<ReturnType<NonNullable<OrderPushAdapter['pushOrder']>>>;
      try {
        outcome = await adapter.pushOrder(state as never, {
          reference: cmd.reference,
          payload: cmd.payload as Record<string, unknown>,
        });
      } catch (error) {
        outcome = { state, error: error instanceof Error ? error : new Error(String(error)) };
      }
      const { pieces: _derived, ...persisted } = outcome.state as Record<string, unknown>;
      await tx
        .update(connections)
        .set({ adapterState: persisted, updatedAt: now() })
        .where(eq(connections.id, conn.id));

      if (outcome.externalRef) {
        result.acknowledged++;
        await tx
          .update(outboundCommands)
          .set({
            status: 'acknowledged',
            attempts: cmd.attempts + 1,
            externalRef: outcome.externalRef,
            acknowledgedAt: now(),
            lastError: null,
            nextAttemptAt: null,
          })
          .where(eq(outboundCommands.id, cmd.id));
        await enqueueEvent(tx, {
          tenantId: cmd.tenantId,
          eventType: 'OrderExportAcknowledged',
          aggregateType: 'outbound_command',
          aggregateId: cmd.id,
          payload: {
            reference: cmd.reference,
            connectionId: cmd.connectionId,
            externalRef: outcome.externalRef,
          },
        });
        continue;
      }
      const attempts = cmd.attempts + 1;
      const message = outcome.error?.message ?? 'Adapter returned no ERP reference';
      if (attempts >= maxAttempts) {
        await fail(`${message} (after ${attempts} attempts)`);
        continue;
      }
      result.retrying++;
      await tx
        .update(outboundCommands)
        .set({
          attempts,
          lastError: (outcome.error?.maybeAccepted
            ? `${message} — will retry with the same reference`
            : message
          ).slice(0, 2000),
          nextAttemptAt: new Date(now().getTime() + Math.min(base * 2 ** (attempts - 1), 30 * 60_000)),
        })
        .where(eq(outboundCommands.id, cmd.id));
    }
  });
  return result;
}
