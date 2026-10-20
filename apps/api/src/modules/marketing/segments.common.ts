import type { SegmentDefinition } from '@uc/contracts';
import { customers } from '@uc/db';
import { and, eq, sql, type SQL } from 'drizzle-orm';

/**
 * SQL conditions over `customers` for a segment (Phase 10). Only confirmed orders count; consent is the latest
 * event for the channel. Column references are written with explicit table names (subqueries alias orders as o).
 */
export function segmentWhere(tenantId: string, def: SegmentDefinition, now: Date): SQL {
  const conds: SQL[] = [eq(customers.tenantId, tenantId), eq(customers.status, 'active')];
  if (def.minOrders !== null)
    conds.push(
      sql`(select count(*) from orders o where o.customer_id = "customers"."id" and o.status = 'confirmed') >= ${def.minOrders}`,
    );
  if (def.minSpentMinor !== null)
    conds.push(
      sql`(select coalesce(sum(o.total_minor), 0) from orders o where o.customer_id = "customers"."id" and o.status = 'confirmed') >= ${def.minSpentMinor}::bigint`,
    );
  if (def.orderedWithinDays !== null) {
    const since = new Date(now.getTime() - def.orderedWithinDays * 86_400_000);
    conds.push(
      sql`exists (select 1 from orders o where o.customer_id = "customers"."id" and o.status = 'confirmed' and o.confirmed_at >= ${since.toISOString()}::timestamptz)`,
    );
  }
  if (def.registeredWithinDays !== null) {
    const since = new Date(now.getTime() - def.registeredWithinDays * 86_400_000);
    conds.push(sql`"customers"."created_at" >= ${since.toISOString()}::timestamptz`);
  }
  if (def.consentChannel !== null) conds.push(consentGranted(def.consentChannel));
  return and(...conds)!;
}

/** The customer's latest marketing consent event for `channel` is "granted". */
export function consentGranted(channel: 'email' | 'sms' | 'whatsapp'): SQL {
  return sql`coalesce((select ce.granted from consent_events ce where ce.customer_id = "customers"."id" and ce.channel = ${channel} and ce.purpose = 'marketing' order by ce.seq desc limit 1), false)`;
}
