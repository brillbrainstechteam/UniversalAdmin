import { sql } from 'drizzle-orm';
import type { Tx } from './client';
import { enqueueEvent } from './outbox';

/**
 * Finds each tenant's CURRENT approved rates (per purity + currency) whose source time is older than the tenant's
 * maximum rate age and emits RateStale once per rate (marked with stale_notified_at, the only column the
 * metal_rates guard lets change after a decision). Runs in a system transaction from the worker.
 */
export async function flagStaleRates(tx: Tx, now = new Date()): Promise<number> {
  const due = await tx.execute<{
    id: string;
    tenant_id: string;
    purity_id: string;
    currency: string;
    source_as_of: string;
  }>(sql`
    with cur as (
      select distinct on (r.tenant_id, r.purity_id, r.currency) r.*
        from metal_rates r
       where r.status = 'approved' and r.effective_from <= ${now}
       order by r.tenant_id, r.purity_id, r.currency, r.effective_from desc, r.decided_at desc, r.id desc
    )
    select cur.id, cur.tenant_id, cur.purity_id, cur.currency, cur.source_as_of
      from cur join pricing_settings s on s.tenant_id = cur.tenant_id
     where cur.stale_notified_at is null
       and cur.source_as_of < ${now}::timestamptz - make_interval(mins => s.rate_max_age_minutes)
     limit 500`);
  for (const r of due.rows) {
    await tx.execute(
      sql`update metal_rates set stale_notified_at = ${now} where id = ${r.id} and stale_notified_at is null`,
    );
    await enqueueEvent(tx, {
      tenantId: r.tenant_id,
      eventType: 'RateStale',
      aggregateType: 'metal_rate',
      aggregateId: r.id,
      payload: {
        rateId: r.id,
        purityId: r.purity_id,
        currency: r.currency,
        sourceAsOf: new Date(r.source_as_of).toISOString(),
      },
    });
  }
  return due.rows.length;
}
