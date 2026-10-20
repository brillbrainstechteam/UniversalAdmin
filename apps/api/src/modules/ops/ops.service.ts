import { Injectable } from '@nestjs/common';
import {
  AutomationAction,
  AutomationConditions,
  type Automation,
  type OpsHealth,
  type OrderListQuery,
  type SaveAutomationRequest,
} from '@uc/contracts';
import {
  automationRuns,
  automations,
  orders,
  outboxEvents,
  staffNotifications,
  webhookEndpoints,
  writeAudit,
  type Tx,
} from '@uc/db';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { Errors } from '../../common/errors';
import { iso, likePattern } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';

type Check = OpsHealth['checks'][number];
const level = (value: number, warn: number, alert: number): Check['status'] =>
  value >= alert ? 'alert' : value >= warn ? 'warn' : 'ok';
const worst = (checks: Check[]): Check['status'] =>
  checks.some((c) => c.status === 'alert')
    ? 'alert'
    : checks.some((c) => c.status === 'warn')
      ? 'warn'
      : 'ok';

/** Automations, staff inbox, operations health and exports (Phase 11, ADR-026). */
@Injectable()
export class OpsService {
  constructor(private readonly db: DbService) {}

  // ---------------------------------------------------------------- automations

  private requireAutomations(ctx: TenantState) {
    if (!ctx.features.includes('automations')) throw Errors.featureNotEntitled('automations');
  }

  private async toAutomations(tx: Tx, rows: (typeof automations.$inferSelect)[]): Promise<Automation[]> {
    const ids = rows.map((r) => r.id);
    const stats = ids.length
      ? (
          await tx.execute<{
            automation_id: string;
            done: number;
            skipped: number;
            failed: number;
            last: Date | null;
          }>(sql`
            select automation_id,
                   count(*) filter (where outcome = 'done')::int as done,
                   count(*) filter (where outcome = 'skipped')::int as skipped,
                   count(*) filter (where outcome = 'failed')::int as failed,
                   max(created_at) as last
              from automation_runs where automation_id in (${sql.join(
                ids.map((i) => sql`${i}::uuid`),
                sql`, `,
              )}) group by 1`)
        ).rows
      : [];
    return rows.map((r) => {
      const s = stats.find((x) => x.automation_id === r.id);
      return {
        id: r.id,
        name: r.name,
        trigger: r.trigger as Automation['trigger'],
        conditions: AutomationConditions.parse(r.conditions),
        action: AutomationAction.parse(r.action),
        status: r.status,
        runs: { done: s?.done ?? 0, skipped: s?.skipped ?? 0, failed: s?.failed ?? 0 },
        lastRunAt: s?.last ? iso(new Date(s.last)) : null,
        version: r.version,
        createdAt: iso(r.createdAt),
      };
    });
  }

  async automations(ctx: TenantState) {
    this.requireAutomations(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => ({
      items: await this.toAutomations(
        tx,
        await tx
          .select()
          .from(automations)
          .where(eq(automations.tenantId, ctx.tenantId))
          .orderBy(asc(automations.name)),
      ),
    }));
  }

  async saveAutomation(
    auth: AuthState,
    ctx: TenantState,
    id: string | null,
    input: SaveAutomationRequest,
    meta: RequestMeta,
  ) {
    this.requireAutomations(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      if (input.action.type === 'webhook') {
        const [ep] = await tx
          .select({ id: webhookEndpoints.id })
          .from(webhookEndpoints)
          .where(
            and(
              eq(webhookEndpoints.id, input.action.endpointId),
              eq(webhookEndpoints.tenantId, ctx.tenantId),
            ),
          );
        if (!ep)
          throw Errors.validation([{ path: 'action.endpointId', message: 'Unknown webhook endpoint' }]);
      }
      const values = {
        name: input.name,
        trigger: input.trigger,
        conditions: input.conditions,
        action: input.action,
        status: input.status,
      };
      let row: typeof automations.$inferSelect | undefined;
      if (id) {
        const [a] = await tx.select().from(automations).where(eq(automations.id, id)).for('update');
        if (!a || a.tenantId !== ctx.tenantId) throw Errors.notFound('Automation');
        if (input.version === undefined || a.version !== input.version)
          throw Errors.versionConflict(a.version);
        [row] = await tx
          .update(automations)
          .set({ ...values, version: a.version + 1, updatedAt: new Date() })
          .where(eq(automations.id, a.id))
          .returning();
      } else
        [row] = await tx
          .insert(automations)
          .values({ tenantId: ctx.tenantId, ...values, createdBy: auth.userId })
          .returning();
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: id ? 'automations.updated' : 'automations.created',
        entityType: 'automation',
        entityId: row!.id,
        newValues: values,
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return (await this.toAutomations(tx, [row!]))[0]!;
    });
  }

  async runs(ctx: TenantState, id: string) {
    this.requireAutomations(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [a] = await tx
        .select({ id: automations.id })
        .from(automations)
        .where(and(eq(automations.id, id), eq(automations.tenantId, ctx.tenantId)));
      if (!a) throw Errors.notFound('Automation');
      const rows = await tx
        .select()
        .from(automationRuns)
        .where(eq(automationRuns.automationId, id))
        .orderBy(desc(automationRuns.createdAt))
        .limit(100);
      return {
        items: rows.map((r) => ({
          id: r.id,
          eventId: r.eventId,
          outcome: r.outcome,
          detail: r.detail,
          createdAt: iso(r.createdAt),
        })),
      };
    });
  }

  // ---------------------------------------------------------------- staff inbox

  async notifications(auth: AuthState, ctx: TenantState) {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(staffNotifications)
        .where(
          and(
            eq(staffNotifications.tenantId, ctx.tenantId),
            or(isNull(staffNotifications.userId), eq(staffNotifications.userId, auth.userId)),
          ),
        )
        .orderBy(desc(staffNotifications.createdAt))
        .limit(50);
      const items = rows.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        link: n.link,
        source: n.source,
        read: n.readBy.includes(auth.userId),
        createdAt: iso(n.createdAt),
      }));
      return { items, unread: items.filter((i) => !i.read).length };
    });
  }

  async markRead(auth: AuthState, ctx: TenantState, ids: string[]) {
    await this.db.tenant(ctx.tenantId, (tx) =>
      tx
        .update(staffNotifications)
        .set({ readBy: sql`array_append(${staffNotifications.readBy}, ${auth.userId}::uuid)` })
        .where(
          and(
            eq(staffNotifications.tenantId, ctx.tenantId),
            inArray(staffNotifications.id, ids),
            sql`not (${auth.userId}::uuid = any(${staffNotifications.readBy}))`,
          ),
        ),
    );
    return this.notifications(auth, ctx);
  }

  // ---------------------------------------------------------------- health

  /** Tenant operations health. Each check documents its thresholds; values come from live tables. */
  async health(ctx: TenantState): Promise<OpsHealth> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const t = ctx.tenantId;
      const one = async (q: SQL) =>
        Number((await tx.execute<{ v: number | string | null }>(q)).rows[0]?.v ?? 0);
      const backlog = await one(
        sql`select count(*) as v from outbox_events where tenant_id = ${t} and status = 'pending' and occurred_at < now() - interval '1 minute'`,
      );
      const deadEvents = await one(
        sql`select count(*) as v from outbox_events where tenant_id = ${t} and status = 'dead'`,
      );
      const failing = await one(
        sql`select count(*) as v from webhook_deliveries where tenant_id = ${t} and status = 'failed'`,
      );
      const deadDeliveries = await one(
        sql`select count(*) as v from webhook_deliveries where tenant_id = ${t} and status = 'dead'`,
      );
      const exportLag = await one(
        sql`select coalesce(extract(epoch from now() - min(created_at)) / 60, 0) as v from outbound_commands where tenant_id = ${t} and status = 'pending'`,
      );
      const staleConnectors = await one(
        sql`select count(*) as v from connections where tenant_id = ${t} and status = 'active' and (last_success_at is null or last_success_at < now() - interval '24 hours')`,
      );
      const oldIssues = await one(
        sql`select count(*) as v from reconciliation_issues where tenant_id = ${t} and status = 'open' and created_at < now() - interval '24 hours'`,
      );
      const staleRates = await one(sql`
        select count(*) as v from (
          select distinct on (r.purity_id, r.currency) r.source_as_of
            from metal_rates r where r.tenant_id = ${t} and r.status = 'approved'
           order by r.purity_id, r.currency, r.effective_from desc
        ) latest, pricing_settings ps
        where ps.tenant_id = ${t} and latest.source_as_of < now() - make_interval(mins => ps.rate_max_age_minutes)`);
      const pay = (
        await tx.execute<{ failed: number; total: number }>(sql`
        select count(*) filter (where status = 'failed')::int as failed, count(*) filter (where status in ('failed','captured'))::int as total
          from payments where tenant_id = ${t} and updated_at > now() - interval '24 hours'`)
      ).rows[0]!;
      const payRate = pay.total >= 5 ? Math.round((pay.failed * 100) / pay.total) : 0;
      const checks: Check[] = [
        {
          key: 'outbox_backlog',
          label: 'Events waiting to be published',
          value: backlog,
          unit: 'count',
          status: level(backlog, 10, 100),
          thresholds: 'warn ≥ 10, alert ≥ 100 (older than 1 minute)',
          detail: null,
        },
        {
          key: 'outbox_dead',
          label: 'Events that failed to publish',
          value: deadEvents,
          unit: 'count',
          status: level(deadEvents, 1, 10),
          thresholds: 'warn ≥ 1, alert ≥ 10',
          detail: deadEvents ? 'A platform operator can replay them' : null,
        },
        {
          key: 'webhooks_failing',
          label: 'Webhook deliveries retrying',
          value: failing,
          unit: 'count',
          status: level(failing, 1, 50),
          thresholds: 'warn ≥ 1, alert ≥ 50',
          detail: null,
        },
        {
          key: 'webhooks_dead',
          label: 'Webhook deliveries given up',
          value: deadDeliveries,
          unit: 'count',
          status: level(deadDeliveries, 1, 10),
          thresholds: 'warn ≥ 1, alert ≥ 10',
          detail: deadDeliveries ? 'Replay them from the webhook endpoint' : null,
        },
        {
          key: 'erp_export_lag',
          label: 'Oldest order waiting for ERP export',
          value: Math.round(exportLag),
          unit: 'minutes',
          status: level(exportLag, 15, 60),
          thresholds: 'warn ≥ 15 min, alert ≥ 60 min',
          detail: null,
        },
        {
          key: 'connector_freshness',
          label: 'Connections without a successful sync in 24 h',
          value: staleConnectors,
          unit: 'count',
          status: level(staleConnectors, 1, 3),
          thresholds: 'warn ≥ 1, alert ≥ 3',
          detail: null,
        },
        {
          key: 'reconciliation_aging',
          label: 'Reconciliation issues open over 24 h',
          value: oldIssues,
          unit: 'count',
          status: level(oldIssues, 1, 20),
          thresholds: 'warn ≥ 1, alert ≥ 20',
          detail: null,
        },
        {
          key: 'stale_rates',
          label: 'Metal rates older than the allowed age',
          value: staleRates,
          unit: 'count',
          status: level(staleRates, 1, 3),
          thresholds: 'warn ≥ 1, alert ≥ 3',
          detail: null,
        },
        {
          key: 'payment_failures',
          label: 'Payment failure rate (24 h, at least 5 attempts)',
          value: payRate,
          unit: 'percent',
          status: level(payRate, 20, 50),
          thresholds: 'warn ≥ 20%, alert ≥ 50%',
          detail: `${pay.failed} of ${pay.total}`,
        },
      ];
      return { status: worst(checks), checks, generatedAt: new Date().toISOString() };
    });
  }

  /** Platform-wide checks for operators (all tenants). */
  async platformHealth(): Promise<OpsHealth> {
    return this.db.system(async (tx) => {
      const one = async (q: SQL) =>
        Number((await tx.execute<{ v: number | string | null }>(q)).rows[0]?.v ?? 0);
      const backlog = await one(
        sql`select count(*) as v from outbox_events where status = 'pending' and occurred_at < now() - interval '1 minute'`,
      );
      const oldest = await one(
        sql`select coalesce(extract(epoch from now() - min(occurred_at)) / 60, 0) as v from outbox_events where status = 'pending'`,
      );
      const dead = await one(sql`select count(*) as v from outbox_events where status = 'dead'`);
      const deadDeliveries = await one(
        sql`select count(*) as v from webhook_deliveries where status = 'dead'`,
      );
      const checks: Check[] = [
        {
          key: 'outbox_backlog',
          label: 'Events waiting to be published (all merchants)',
          value: backlog,
          unit: 'count',
          status: level(backlog, 50, 500),
          thresholds: 'warn ≥ 50, alert ≥ 500',
          detail: null,
        },
        {
          key: 'outbox_lag',
          label: 'Oldest unpublished event',
          value: Math.round(oldest),
          unit: 'minutes',
          status: level(oldest, 5, 30),
          thresholds: 'warn ≥ 5 min, alert ≥ 30 min',
          detail: null,
        },
        {
          key: 'outbox_dead',
          label: 'Dead events (all merchants)',
          value: dead,
          unit: 'count',
          status: level(dead, 1, 25),
          thresholds: 'warn ≥ 1, alert ≥ 25',
          detail: null,
        },
        {
          key: 'webhooks_dead',
          label: 'Dead webhook deliveries (all merchants)',
          value: deadDeliveries,
          unit: 'count',
          status: level(deadDeliveries, 1, 50),
          thresholds: 'warn ≥ 1, alert ≥ 50',
          detail: null,
        },
      ];
      return { status: worst(checks), checks, generatedAt: new Date().toISOString() };
    });
  }

  async deadEvents() {
    return this.db.system(async (tx) => {
      const rows = await tx
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.status, 'dead'))
        .orderBy(desc(outboxEvents.occurredAt))
        .limit(200);
      return {
        items: rows.map((e) => ({
          id: e.id,
          tenantId: e.tenantId,
          eventType: e.eventType,
          attempts: e.attempts,
          lastError: e.lastError,
          occurredAt: iso(e.occurredAt),
        })),
      };
    });
  }

  /** Puts a dead event back in the relay queue (consumers dedupe by event id, so replay is safe). */
  async replayDead(auth: AuthState, id: string, meta: RequestMeta) {
    return this.db.system(async (tx) => {
      const [e] = await tx
        .update(outboxEvents)
        .set({ status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null })
        .where(and(eq(outboxEvents.id, id), eq(outboxEvents.status, 'dead')))
        .returning();
      if (!e) throw Errors.notFound('Dead event');
      await writeAudit(tx, {
        tenantId: null,
        actorType: 'platform',
        actorUserId: auth.userId,
        action: 'platform.event_replayed',
        entityType: 'outbox_event',
        entityId: e.id,
        newValues: { eventType: e.eventType, tenantId: e.tenantId },
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return { status: 'pending' as const };
    });
  }

  // ---------------------------------------------------------------- bulk export

  /** Orders CSV with the list's filters (max 10 000 rows). Money in minor units; formula injection neutralised. */
  async ordersCsv(ctx: TenantState, q: Omit<OrderListQuery, 'cursor' | 'limit'>): Promise<string> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const where: (SQL | undefined)[] = [
        eq(orders.tenantId, ctx.tenantId),
        q.status ? eq(orders.status, q.status) : undefined,
        q.paymentStatus ? eq(orders.paymentStatus, q.paymentStatus) : undefined,
        q.fulfillmentStatus ? eq(orders.fulfillmentStatus, q.fulfillmentStatus) : undefined,
        q.channelId ? eq(orders.channelId, q.channelId) : undefined,
        q.origin ? eq(orders.origin, q.origin) : undefined,
        q.customerId ? eq(orders.customerId, q.customerId) : undefined,
        q.q
          ? or(
              ilike(orders.number, likePattern(q.q)),
              sql`${orders.contact}->>'email' ilike ${likePattern(q.q)}`,
            )
          : undefined,
      ];
      const rows = await tx
        .select()
        .from(orders)
        .where(and(...where))
        .orderBy(desc(orders.createdAt))
        .limit(10_000);
      const esc = (v: unknown) => {
        const s = v === null || v === undefined ? '' : String(v);
        const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
        return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
      };
      const header = [
        'number',
        'created_at',
        'origin',
        'status',
        'payment_status',
        'fulfillment_status',
        'currency',
        'subtotal_minor',
        'discount_minor',
        'tax_minor',
        'total_minor',
        'contact_name',
        'contact_email',
      ];
      const lines = rows.map((o) => {
        const c = o.contact as { name?: string; email?: string };
        return [
          o.number,
          o.createdAt.toISOString(),
          o.origin,
          o.status,
          o.paymentStatus,
          o.fulfillmentStatus,
          o.currency,
          o.subtotalMinor,
          o.discountMinor,
          o.taxMinor,
          o.totalMinor,
          c.name,
          c.email,
        ]
          .map(esc)
          .join(',');
      });
      return [header.join(','), ...lines].join('\n') + '\n';
    });
  }
}
