import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { SaveWebhookEndpointRequest, WebhookDeliveryQuery, WebhookEndpoint } from '@uc/contracts';
import {
  assertPublicUrl,
  encryptSecret,
  webhookDeliveries,
  webhookEndpoints,
  writeAudit,
  type Tx,
} from '@uc/db';
import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import { decodeCursor, paginate } from '../../common/cursor';
import { AppError, Errors } from '../../common/errors';
import { iso } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { DbService } from '../../db/db.service';

type Row = typeof webhookEndpoints.$inferSelect;

/** Outbound webhook endpoints (Phase 11, ADR-026). Deliveries are made by the worker. */
@Injectable()
export class WebhooksService {
  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  toEndpoint(r: Row): WebhookEndpoint {
    return {
      id: r.id,
      name: r.name,
      url: r.url,
      eventTypes: r.eventTypes as WebhookEndpoint['eventTypes'],
      status: r.status,
      secretHint: r.secretHint,
      consecutiveFailures: r.consecutiveFailures,
      lastSuccessAt: r.lastSuccessAt ? iso(r.lastSuccessAt) : null,
      lastFailureAt: r.lastFailureAt ? iso(r.lastFailureAt) : null,
      version: r.version,
      createdAt: iso(r.createdAt),
    };
  }

  private async safeUrl(url: string) {
    try {
      await assertPublicUrl(url, this.config.WEBHOOKS_ALLOW_PRIVATE_TARGETS);
    } catch (e) {
      throw new AppError(422, 'UNSAFE_URL', (e as Error).message, { field: 'url' });
    }
  }

  private newSecret() {
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    return {
      secret,
      sealed: encryptSecret(secret, this.config.SECRETS_ENCRYPTION_KEY),
      hint: `…${secret.slice(-4)}`,
    };
  }

  private audit(
    tx: Tx,
    auth: AuthState,
    ctx: TenantState,
    meta: RequestMeta,
    action: string,
    id: string,
    values: Record<string, unknown>,
  ) {
    return writeAudit(tx, {
      tenantId: ctx.tenantId,
      actorType: 'user',
      actorUserId: auth.userId,
      action,
      entityType: 'webhook_endpoint',
      entityId: id,
      newValues: values,
      correlationId: meta.correlationId,
      ip: meta.ip,
    });
  }

  async list(ctx: TenantState) {
    return this.db.tenant(ctx.tenantId, async (tx) => ({
      items: (
        await tx
          .select()
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.tenantId, ctx.tenantId))
          .orderBy(desc(webhookEndpoints.createdAt))
      ).map((r) => this.toEndpoint(r)),
    }));
  }

  private async load(tx: Tx, ctx: TenantState, id: string, lock = false) {
    const q = tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id));
    const [r] = lock ? await q.for('update') : await q;
    if (!r || r.tenantId !== ctx.tenantId) throw Errors.notFound('Webhook endpoint');
    return r;
  }

  async create(auth: AuthState, ctx: TenantState, input: SaveWebhookEndpointRequest, meta: RequestMeta) {
    await this.safeUrl(input.url);
    const s = this.newSecret();
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .insert(webhookEndpoints)
        .values({
          tenantId: ctx.tenantId,
          name: input.name,
          url: input.url,
          eventTypes: [...new Set(input.eventTypes)],
          status: input.status,
          secretSealed: s.sealed,
          secretHint: s.hint,
          createdBy: auth.userId,
        })
        .returning();
      await this.audit(tx, auth, ctx, meta, 'webhooks.created', row!.id, {
        name: row!.name,
        url: row!.url,
        eventTypes: row!.eventTypes,
      });
      return { endpoint: this.toEndpoint(row!), secret: s.secret };
    });
  }

  async update(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: SaveWebhookEndpointRequest,
    meta: RequestMeta,
  ) {
    await this.safeUrl(input.url);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const r = await this.load(tx, ctx, id, true);
      if (input.version === undefined || r.version !== input.version) throw Errors.versionConflict(r.version);
      const [after] = await tx
        .update(webhookEndpoints)
        .set({
          name: input.name,
          url: input.url,
          eventTypes: [...new Set(input.eventTypes)],
          status: input.status,
          ...(input.status === 'active' && r.status !== 'active' ? { consecutiveFailures: 0 } : {}),
          version: r.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(webhookEndpoints.id, r.id))
        .returning();
      await this.audit(tx, auth, ctx, meta, 'webhooks.updated', r.id, {
        url: input.url,
        status: input.status,
        eventTypes: input.eventTypes,
      });
      return this.toEndpoint(after!);
    });
  }

  /** New signing secret; the old one stops working immediately. */
  async rotate(auth: AuthState, ctx: TenantState, id: string, meta: RequestMeta) {
    const s = this.newSecret();
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const r = await this.load(tx, ctx, id, true);
      const [after] = await tx
        .update(webhookEndpoints)
        .set({ secretSealed: s.sealed, secretHint: s.hint, version: r.version + 1, updatedAt: new Date() })
        .where(eq(webhookEndpoints.id, r.id))
        .returning();
      await this.audit(tx, auth, ctx, meta, 'webhooks.secret_rotated', r.id, {});
      return { endpoint: this.toEndpoint(after!), secret: s.secret };
    });
  }

  async remove(auth: AuthState, ctx: TenantState, id: string, meta: RequestMeta) {
    await this.db.tenant(ctx.tenantId, async (tx) => {
      const r = await this.load(tx, ctx, id, true);
      await tx.delete(webhookEndpoints).where(eq(webhookEndpoints.id, r.id));
      await this.audit(tx, auth, ctx, meta, 'webhooks.deleted', r.id, { url: r.url });
    });
  }

  /** Queues a signed "ping" delivery so the receiver can be checked end to end. */
  async test(ctx: TenantState, id: string) {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const r = await this.load(tx, ctx, id);
      const eventId = randomUUID();
      const [d] = await tx
        .insert(webhookDeliveries)
        .values({
          tenantId: ctx.tenantId,
          endpointId: r.id,
          eventId,
          eventType: 'Ping',
          payload: {
            id: eventId,
            type: 'Ping',
            occurredAt: new Date().toISOString(),
            tenantId: ctx.tenantId,
            data: { message: 'Test delivery from Universal Commerce' },
          },
          source: 'test',
        })
        .returning();
      return { deliveryId: d!.id };
    });
  }

  async deliveries(ctx: TenantState, id: string, q: WebhookDeliveryQuery) {
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await this.load(tx, ctx, id);
      const where: (SQL | undefined)[] = [
        eq(webhookDeliveries.endpointId, id),
        q.status ? eq(webhookDeliveries.status, q.status) : undefined,
      ];
      if (cursor) {
        const t = new Date(String(cursor.sortValue));
        where.push(
          or(
            lt(webhookDeliveries.createdAt, t),
            and(eq(webhookDeliveries.createdAt, t), lt(webhookDeliveries.id, cursor.id)),
          ),
        );
      }
      const rows = await tx
        .select()
        .from(webhookDeliveries)
        .where(and(...where))
        .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
        .limit(q.limit + 1);
      const page = paginate(rows, q.limit, (r) => r.createdAt.toISOString());
      return {
        items: page.items.map((d) => ({
          id: d.id,
          eventId: d.eventId,
          eventType: d.eventType,
          source: d.source,
          status: d.status,
          attempts: d.attempts,
          nextAttemptAt: iso(d.nextAttemptAt),
          lastStatusCode: d.lastStatusCode,
          lastError: d.lastError,
          deliveredAt: d.deliveredAt ? iso(d.deliveredAt) : null,
          createdAt: iso(d.createdAt),
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  /** Puts a failed or dead delivery back in the queue (same event id: receivers dedupe on it). */
  async replay(auth: AuthState, ctx: TenantState, deliveryId: string, meta: RequestMeta) {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [d] = await tx
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, deliveryId))
        .for('update');
      if (!d || d.tenantId !== ctx.tenantId) throw Errors.notFound('Delivery');
      if (d.status === 'delivered' || d.status === 'pending')
        throw Errors.conflict('INVALID_STATE_TRANSITION', `This delivery is ${d.status}`);
      await tx
        .update(webhookDeliveries)
        .set({ status: 'pending', attempts: 0, nextAttemptAt: new Date() })
        .where(eq(webhookDeliveries.id, d.id));
      await this.audit(tx, auth, ctx, meta, 'webhooks.delivery_replayed', d.endpointId, {
        deliveryId: d.id,
        eventId: d.eventId,
      });
      return { status: 'pending' as const };
    });
  }
}
