import { Injectable } from '@nestjs/common';
import { REPORTS, type ReportKey, type ReportQuery, type ReportResult } from '@uc/contracts';
import { tenants } from '@uc/db';
import { eq, sql, type SQL } from 'drizzle-orm';
import { Errors } from '../../common/errors';
import type { TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';

type Row = Record<string, string | number | null>;

function requireAnalytics(ctx: Pick<TenantState, 'features'>) {
  if (!ctx.features.includes('analytics')) throw Errors.featureNotEntitled('analytics');
}

const ymd = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);

/**
 * Reports (Phase 10, ADR-025). Every report is a fixed SQL query over the platform's own records with the metric
 * formulas published in `REPORTS`. Days are calendar days in the store's time zone; amounts are integer minor units
 * of the store currency (other currencies are counted in the notes, never mixed in).
 */
@Injectable()
export class ReportsService {
  constructor(private readonly db: DbService) {}

  list(ctx: TenantState) {
    requireAnalytics(ctx);
    return { items: (Object.keys(REPORTS) as ReportKey[]).map((key) => ({ key, ...REPORTS[key] })) };
  }

  async run(ctx: TenantState, key: ReportKey, q: ReportQuery): Promise<ReportResult> {
    requireAnalytics(ctx);
    const def = { key, ...REPORTS[key] };
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [t] = await tx
        .select({ tz: tenants.timezone, currency: tenants.defaultCurrency })
        .from(tenants)
        .where(eq(tenants.id, ctx.tenantId));
      const tz = t!.tz;
      const now = new Date();
      const to = q.to ?? ymd(now, tz);
      const from = q.from ?? ymd(new Date(now.getTime() - 29 * 86_400_000), tz);
      if (from > to)
        throw Errors.validation([{ path: 'from', message: 'The start date is after the end date' }]);
      // [start, end) as instants: local midnight of `from` to local midnight after `to`.
      const start = sql`((${from})::date::timestamp at time zone ${tz})`;
      const end = sql`(((${to})::date + 1)::timestamp at time zone ${tz})`;
      const day = (col: SQL) => sql`to_char((${col} at time zone ${tz})::date, 'YYYY-MM-DD')`;
      const chan = (col: SQL) => (q.channelId ? sql`and ${col} = ${q.channelId}::uuid` : sql``);
      const notes = [...def.notes];
      let rows: Row[] = [];
      const exec = async (query: SQL) => (await tx.execute<Row>(query)).rows;
      switch (key) {
        case 'sales': {
          const orders = await exec(sql`
            select ${day(sql`o.confirmed_at`)} as day, count(*)::int as orders,
                   sum(o.subtotal_minor)::text as gross, sum(o.discount_minor)::text as discounts,
                   sum(o.tax_minor)::text as tax, sum(o.total_minor)::text as total
              from orders o
             where o.tenant_id = ${ctx.tenantId} and o.status = 'confirmed' and o.currency = ${t!.currency}
               and o.confirmed_at >= ${start} and o.confirmed_at < ${end} ${chan(sql`o.channel_id`)}
             group by 1`);
          const refunds = await exec(sql`
            select ${day(sql`r.updated_at`)} as day, sum(r.amount_minor)::text as refunds
              from refunds r join orders o on o.id = r.order_id
             where r.tenant_id = ${ctx.tenantId} and r.status = 'succeeded' and r.currency = ${t!.currency}
               and r.updated_at >= ${start} and r.updated_at < ${end} ${chan(sql`o.channel_id`)}
             group by 1`);
          const days = [
            ...new Set([...orders.map((r) => String(r.day)), ...refunds.map((r) => String(r.day))]),
          ].sort();
          rows = days.map((d) => {
            const o = orders.find((r) => r.day === d);
            const refund = String(refunds.find((r) => r.day === d)?.refunds ?? '0');
            const total = String(o?.total ?? '0');
            return {
              day: d,
              orders: Number(o?.orders ?? 0),
              gross: String(o?.gross ?? '0'),
              discounts: String(o?.discounts ?? '0'),
              tax: String(o?.tax ?? '0'),
              total,
              refunds: refund,
              net: (BigInt(total) - BigInt(refund)).toString(),
            };
          });
          const [other] = await exec(sql`
            select count(*)::int as n from orders o where o.tenant_id = ${ctx.tenantId} and o.status = 'confirmed'
               and o.currency <> ${t!.currency} and o.confirmed_at >= ${start} and o.confirmed_at < ${end}`);
          if (Number(other?.n ?? 0) > 0)
            notes.push(`${String(other!.n)} confirmed order(s) in other currencies are not included.`);
          break;
        }
        case 'metal_weight':
          rows = await exec(sql`
            select coalesce(si.metal, js.metal) as metal, coalesce(ol.price_snapshot->'measurements'->>'purity', '—') as purity,
                   sum(ol.quantity)::int as pieces,
                   to_char(sum(((ol.price_snapshot->'measurements'->>'netG')::numeric) * ol.quantity), 'FM999999990.000') as "netG",
                   to_char(sum(((ol.price_snapshot->'measurements'->>'grossG')::numeric) * ol.quantity), 'FM999999990.000') as "grossG"
              from order_lines ol
              join orders o on o.id = ol.order_id
              left join serial_items si on si.id = ol.serial_item_id
              left join jewellery_specs js on js.variant_id = ol.variant_id
             where o.tenant_id = ${ctx.tenantId} and o.status = 'confirmed'
               and o.confirmed_at >= ${start} and o.confirmed_at < ${end} ${chan(sql`o.channel_id`)}
               and ol.price_snapshot->'measurements'->>'netG' is not null
             group by 1, 2 order by 1, 2`);
          break;
        case 'stock_age': {
          const bucket = (age: SQL) =>
            sql`case when ${age} <= 30 then '0–30 days' when ${age} <= 90 then '31–90 days' when ${age} <= 180 then '91–180 days' when ${age} <= 365 then '181–365 days' else 'over 365 days' end`;
          const pieceAge = sql`extract(day from now() - coalesce((select min(m.occurred_at) from stock_movements m where m.serial_item_id = s.id and m.type = 'receipt'), s.created_at))`;
          const pieces = await exec(sql`
            select ${bucket(pieceAge)} as bucket, count(*)::int as pieces
              from serial_items s
             where s.tenant_id = ${ctx.tenantId} and s.stock_state in ('in_stock', 'reserved', 'committed')
               ${q.locationId ? sql`and s.location_id = ${q.locationId}::uuid` : sql``}
             group by 1`);
          const unitAge = sql`extract(day from now() - coalesce((select max(m.occurred_at) from stock_movements m where m.variant_id = b.variant_id and m.location_id = b.location_id and m.type in ('receipt', 'transfer_receive', 'return_receive')), b.updated_at))`;
          const units = await exec(sql`
            select ${bucket(unitAge)} as bucket, to_char(sum(b.on_hand), 'FM999999990.###') as units
              from stock_balances b
             where b.tenant_id = ${ctx.tenantId} and b.condition = 'sellable' and b.on_hand > 0
               and not exists (select 1 from serial_items s where s.variant_id = b.variant_id)
               ${q.locationId ? sql`and b.location_id = ${q.locationId}::uuid` : sql``}
             group by 1`);
          rows = ['0–30 days', '31–90 days', '91–180 days', '181–365 days', 'over 365 days'].map((b) => ({
            bucket: b,
            pieces: Number(pieces.find((p) => p.bucket === b)?.pieces ?? 0),
            units: String(units.find((u) => u.bucket === b)?.units ?? '0'),
          }));
          break;
        }
        case 'order_sync':
          rows = await exec(sql`
            select c.name as connection, oc.status, count(*)::int as commands
              from outbound_commands oc join connections c on c.id = oc.connection_id
             where oc.tenant_id = ${ctx.tenantId} and oc.reference like 'ORDER:%'
               and oc.created_at >= ${start} and oc.created_at < ${end}
             group by 1, 2 order by 1, 2`);
          break;
        case 'conversion':
          rows = (
            await exec(sql`
              select ${day(sql`c.created_at`)} as day, count(*)::int as carts,
                     count(c.order_id)::int as converted,
                     count(*) filter (where o.status = 'confirmed')::int as paid
                from carts c left join orders o on o.id = c.order_id
               where c.tenant_id = ${ctx.tenantId} and c.created_at >= ${start} and c.created_at < ${end} ${chan(sql`c.channel_id`)}
               group by 1 order by 1`)
          ).map((r) => ({
            ...r,
            rate: Number(r.carts) ? ((Number(r.paid) * 100) / Number(r.carts)).toFixed(1) : '0.0',
          }));
          break;
        case 'channels':
          rows = await exec(sql`
            select coalesce(ch.name, 'Staff / quotations') as channel, o.fulfillment_status as fulfillment,
                   count(*)::int as orders, sum(o.total_minor)::text as total
              from orders o left join channels ch on ch.id = o.channel_id
             where o.tenant_id = ${ctx.tenantId} and o.status = 'confirmed' and o.currency = ${t!.currency}
               and o.created_at >= ${start} and o.created_at < ${end}
             group by 1, 2 order by 1, 2`);
          break;
        case 'attribution':
          rows = await exec(sql`
            select coalesce(o.attribution->>'source', '(direct / unknown)') as source,
                   coalesce(o.attribution->>'medium', '—') as medium,
                   coalesce(o.attribution->>'campaign', '—') as campaign,
                   count(*)::int as orders, sum(o.total_minor)::text as total
              from orders o
             where o.tenant_id = ${ctx.tenantId} and o.status = 'confirmed' and o.origin = 'storefront'
               and o.currency = ${t!.currency} and o.confirmed_at >= ${start} and o.confirmed_at < ${end} ${chan(sql`o.channel_id`)}
             group by 1, 2, 3 order by 4 desc`);
          break;
      }
      const totals: Row = {};
      for (const m of def.metrics) {
        if (m.unit === 'percent') continue;
        if (m.unit === 'money')
          totals[m.key] = rows.reduce((a, r) => a + BigInt(String(r[m.key] ?? '0')), 0n).toString();
        else if (m.unit === 'count') totals[m.key] = rows.reduce((a, r) => a + Number(r[m.key] ?? 0), 0);
        else
          totals[m.key] = rows.reduce((a, r) => a + Number.parseFloat(String(r[m.key] ?? '0')), 0).toFixed(3);
      }
      if (key === 'conversion')
        totals.rate = Number(totals.carts)
          ? ((Number(totals.paid) * 100) / Number(totals.carts)).toFixed(1)
          : '0.0';
      return {
        definition: { ...def, notes },
        filters: { from, to, timezone: tz, channelId: q.channelId ?? null, locationId: q.locationId ?? null },
        rows,
        totals,
        currency: def.metrics.some((m) => m.unit === 'money') ? t!.currency : null,
        generatedAt: now.toISOString(),
      };
    });
  }

  /** CSV with a header row; money columns are minor units (named *_minor) so nothing is rounded. */
  static toCsv(r: ReportResult): string {
    const cols = [...r.definition.dimensions.map((d) => d.key), ...r.definition.metrics.map((m) => m.key)];
    const header = cols.map((c) =>
      r.definition.metrics.find((m) => m.key === c)?.unit === 'money' ? `${c}_minor` : c,
    );
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; // no spreadsheet formula injection
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    return (
      [header.join(','), ...r.rows.map((row) => cols.map((c) => esc(row[c])).join(','))].join('\n') + '\n'
    );
  }
}
