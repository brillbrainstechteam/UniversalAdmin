import { initialSimulatorState } from '@uc/connector-sdk';
import {
  connections,
  createDb,
  outboundCommands,
  provisionTenantRecords,
  requireEnv,
  resetSchema,
  runMigrations,
  systemTx,
} from '@uc/db';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOutboundPass } from '../src/integration-jobs';

const handle = createDb(requireEnv('TEST_DATABASE_URL'), { max: 3 });
const owner = new Pool({ connectionString: requireEnv('TEST_DATABASE_OWNER_URL'), max: 2 });
let tenantId: string;
let connectionId: string;

beforeAll(async () => {
  await resetSchema(requireEnv('TEST_DATABASE_OWNER_URL'));
  await runMigrations(requireEnv('TEST_DATABASE_OWNER_URL'));
  await systemTx(handle.db, async (tx) => {
    const p = await provisionTenantRecords(tx, {
      slug: 'int-worker',
      displayName: 'Integration worker test (DEMO)',
      legalName: 'Integration worker test',
      preset: 'general_commerce',
      countryCode: 'IN',
      defaultCurrency: 'INR',
      timezone: 'Asia/Kolkata',
      defaultLocale: 'en-IN',
      contactEmail: null,
      isDemo: true,
    });
    tenantId = p.tenant.id;
    const [c] = await tx
      .insert(connections)
      .values({
        tenantId,
        connectorKey: 'simulator',
        name: 'Worker simulator',
        settings: {},
        ownership: {},
        adapterState: { ...initialSimulatorState(), failNext: 1, timeoutNext: 1 },
      })
      .returning({ id: connections.id });
    connectionId = c!.id;
    await tx.insert(outboundCommands).values({
      tenantId,
      connectionId,
      kind: 'push_order',
      reference: 'W-1',
      payload: { lines: [] },
      nextAttemptAt: new Date(),
    });
  });
});
afterAll(async () => {
  await handle.close();
  await owner.end();
});

describe('outbound order export relay (X-09)', () => {
  it('retries an outage and a post-acceptance timeout, then acknowledges once', async () => {
    expect(await runOutboundPass(handle.db, { backoffBaseMs: 0 })).toEqual({
      acknowledged: 0,
      retrying: 1,
      failed: 0,
    });
    expect(await runOutboundPass(handle.db, { backoffBaseMs: 0 })).toEqual({
      acknowledged: 0,
      retrying: 1,
      failed: 0,
    });
    expect(await runOutboundPass(handle.db, { backoffBaseMs: 0 })).toEqual({
      acknowledged: 1,
      retrying: 0,
      failed: 0,
    });
    expect(await runOutboundPass(handle.db, { backoffBaseMs: 0 })).toEqual({
      acknowledged: 0,
      retrying: 0,
      failed: 0,
    });
    const cmd = (await owner.query('select status, attempts, external_ref from outbound_commands')).rows[0];
    expect(cmd).toEqual({ status: 'acknowledged', attempts: 3, external_ref: 'SIM-SO-00001' });
    const state = (await owner.query('select adapter_state from connections where id = $1', [connectionId]))
      .rows[0].adapter_state;
    expect(state).toEqual({ tick: 0, failNext: 0, timeoutNext: 0, orders: { 'W-1': 'SIM-SO-00001' } }); // derived flags not persisted
  });

  it('marks commands for paused connections as failed exceptions instead of sending them', async () => {
    await owner.query("update connections set status = 'paused' where id = $1", [connectionId]);
    await owner.query(
      "insert into outbound_commands (tenant_id, connection_id, kind, reference, payload, next_attempt_at) values ($1, $2, 'push_order', 'W-2', '{}', now())",
      [tenantId, connectionId],
    );
    expect(await runOutboundPass(handle.db)).toEqual({ acknowledged: 0, retrying: 0, failed: 1 });
    const row = (
      await owner.query("select status, last_error from outbound_commands where reference = 'W-2'")
    ).rows[0];
    expect(row).toEqual({ status: 'failed', last_error: 'Connection is paused' });
  });
});
