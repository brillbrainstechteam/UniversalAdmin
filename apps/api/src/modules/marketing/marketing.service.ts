import { Injectable } from '@nestjs/common';
import {
  SegmentDefinition,
  type Campaign,
  type Page,
  type PageQuery,
  type SaveCampaignRequest,
  type SaveSegmentRequest,
  type Segment,
  type z,
} from '@uc/contracts';
import { campaignRecipients, campaigns, customers, segments, writeAudit, type Tx } from '@uc/db';
import { and, asc, desc, eq, gt, lt, not, or, sql, type SQL } from 'drizzle-orm';
import { decodeCursor, encodeCursor, paginate } from '../../common/cursor';
import { Errors } from '../../common/errors';
import { iso } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';
import { consentGranted, segmentWhere } from './segments.common';

export const SEND_BLOCKED_REASON =
  'No e-mail/SMS/WhatsApp connector is configured (Phase 11); recipients are prepared but nothing is sent';

function requireMarketing(ctx: Pick<TenantState, 'features'>) {
  if (!ctx.features.includes('marketing')) throw Errors.featureNotEntitled('marketing');
}

/** Segments and campaigns (Phase 10, ADR-025). Consent is always the latest event per channel. */
@Injectable()
export class MarketingService {
  constructor(private readonly db: DbService) {}

  private audit(
    tx: Tx,
    auth: AuthState,
    ctx: TenantState,
    meta: RequestMeta,
    action: string,
    type: string,
    id: string,
    values: Record<string, unknown>,
  ) {
    return writeAudit(tx, {
      tenantId: ctx.tenantId,
      actorType: 'user',
      actorUserId: auth.userId,
      action,
      entityType: type,
      entityId: id,
      newValues: values,
      correlationId: meta.correlationId,
      ip: meta.ip,
    });
  }

  private async count(tx: Tx, tenantId: string, def: SegmentDefinition) {
    const [{ n }] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(customers)
      .where(segmentWhere(tenantId, def, new Date()))) as [{ n: number }];
    return n;
  }

  private async toSegment(tx: Tx, r: typeof segments.$inferSelect): Promise<Segment> {
    const def = SegmentDefinition.parse(r.definition);
    return {
      id: r.id,
      name: r.name,
      definition: def,
      customerCount: await this.count(tx, r.tenantId, def),
      version: r.version,
      createdAt: iso(r.createdAt),
      updatedAt: iso(r.updatedAt),
    };
  }

  async segments(ctx: TenantState): Promise<{ items: Segment[] }> {
    requireMarketing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(segments)
        .where(eq(segments.tenantId, ctx.tenantId))
        .orderBy(asc(segments.name));
      return { items: await Promise.all(rows.map((r) => this.toSegment(tx, r))) };
    });
  }

  async saveSegment(
    auth: AuthState,
    ctx: TenantState,
    id: string | null,
    input: SaveSegmentRequest,
    meta: RequestMeta,
  ): Promise<Segment> {
    requireMarketing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      let row: typeof segments.$inferSelect | undefined;
      if (id) {
        const [s] = await tx.select().from(segments).where(eq(segments.id, id)).for('update');
        if (!s || s.tenantId !== ctx.tenantId) throw Errors.notFound('Segment');
        if (input.version === undefined || s.version !== input.version)
          throw Errors.versionConflict(s.version);
        [row] = await tx
          .update(segments)
          .set({
            name: input.name,
            definition: input.definition,
            version: s.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(segments.id, s.id))
          .returning();
      } else {
        [row] = await tx
          .insert(segments)
          .values({
            tenantId: ctx.tenantId,
            name: input.name,
            definition: input.definition,
            createdBy: auth.userId,
          })
          .onConflictDoNothing()
          .returning();
        if (!row) throw Errors.duplicate('name', 'A segment with this name exists');
      }
      await this.audit(
        tx,
        auth,
        ctx,
        meta,
        id ? 'marketing.segment_updated' : 'marketing.segment_created',
        'segment',
        row!.id,
        { name: input.name, definition: input.definition },
      );
      return this.toSegment(tx, row!);
    });
  }

  async members(ctx: TenantState, id: string, q: z.infer<typeof PageQuery>) {
    requireMarketing(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [s] = await tx
        .select()
        .from(segments)
        .where(and(eq(segments.id, id), eq(segments.tenantId, ctx.tenantId)));
      if (!s) throw Errors.notFound('Segment');
      const def = SegmentDefinition.parse(s.definition);
      const where: SQL[] = [segmentWhere(ctx.tenantId, def, new Date())];
      if (cursor) where.push(gt(customers.id, cursor.id));
      const rows = await tx
        .select({ id: customers.id, displayName: customers.displayName, email: customers.email })
        .from(customers)
        .where(and(...where))
        .orderBy(asc(customers.id))
        .limit(q.limit + 1);
      const page = paginate(rows, q.limit, () => null);
      return {
        count: await this.count(tx, ctx.tenantId, def),
        items: page.items,
        nextCursor: page.nextCursor,
      };
    });
  }

  // ---------------------------------------------------------------- campaigns

  private async toCampaigns(tx: Tx, rows: (typeof campaigns.$inferSelect)[]): Promise<Campaign[]> {
    const segs = await tx
      .select({ id: segments.id, name: segments.name })
      .from(segments)
      .where(eq(segments.tenantId, rows[0]?.tenantId ?? '00000000-0000-0000-0000-000000000000'));
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      channel: c.channel,
      segment: segs.find((s) => s.id === c.segmentId) ?? { id: c.segmentId, name: '—' },
      subject: c.subject,
      body: c.body,
      status: c.status,
      preparedAt: c.preparedAt ? iso(c.preparedAt) : null,
      recipientCount: c.recipientCount,
      excludedNoConsent: c.excludedNoConsent,
      sendBlockedReason: SEND_BLOCKED_REASON,
      version: c.version,
      createdAt: iso(c.createdAt),
    }));
  }

  async campaigns(ctx: TenantState, q: z.infer<typeof PageQuery>): Promise<Page<Campaign>> {
    requireMarketing(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const where: (SQL | undefined)[] = [eq(campaigns.tenantId, ctx.tenantId)];
      if (cursor) {
        const t = new Date(String(cursor.sortValue));
        where.push(
          or(lt(campaigns.createdAt, t), and(eq(campaigns.createdAt, t), lt(campaigns.id, cursor.id))),
        );
      }
      const rows = await tx
        .select()
        .from(campaigns)
        .where(and(...where))
        .orderBy(desc(campaigns.createdAt), desc(campaigns.id))
        .limit(q.limit + 1);
      const page = paginate(rows, q.limit, (r) => r.createdAt.toISOString());
      return { items: await this.toCampaigns(tx, page.items), nextCursor: page.nextCursor };
    });
  }

  async saveCampaign(
    auth: AuthState,
    ctx: TenantState,
    id: string | null,
    input: SaveCampaignRequest,
    meta: RequestMeta,
  ): Promise<Campaign> {
    requireMarketing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [seg] = await tx
        .select({ id: segments.id })
        .from(segments)
        .where(and(eq(segments.id, input.segmentId), eq(segments.tenantId, ctx.tenantId)));
      if (!seg) throw Errors.validation([{ path: 'segmentId', message: 'Unknown segment' }]);
      const values = {
        name: input.name,
        channel: input.channel,
        segmentId: input.segmentId,
        subject: input.subject,
        body: input.body,
      };
      let row: typeof campaigns.$inferSelect | undefined;
      if (id) {
        const [c] = await tx.select().from(campaigns).where(eq(campaigns.id, id)).for('update');
        if (!c || c.tenantId !== ctx.tenantId) throw Errors.notFound('Campaign');
        if (input.version === undefined || c.version !== input.version)
          throw Errors.versionConflict(c.version);
        if (c.status !== 'draft')
          throw Errors.conflict(
            'INVALID_STATE_TRANSITION',
            'A prepared campaign cannot be edited; copy it instead',
          );
        [row] = await tx
          .update(campaigns)
          .set({ ...values, version: c.version + 1, updatedAt: new Date() })
          .where(eq(campaigns.id, c.id))
          .returning();
      } else {
        [row] = await tx
          .insert(campaigns)
          .values({ tenantId: ctx.tenantId, ...values, createdBy: auth.userId })
          .returning();
      }
      await this.audit(
        tx,
        auth,
        ctx,
        meta,
        id ? 'marketing.campaign_updated' : 'marketing.campaign_created',
        'campaign',
        row!.id,
        values,
      );
      return (await this.toCampaigns(tx, [row!]))[0]!;
    });
  }

  /**
   * Snapshots the audience: segment members whose latest consent for the campaign channel is granted (and who have
   * an address for it). Everyone else is counted as excluded. Recipients stay `not_sent` — sending is blocked.
   */
  async prepare(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    version: number,
    meta: RequestMeta,
  ): Promise<Campaign> {
    requireMarketing(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [c] = await tx.select().from(campaigns).where(eq(campaigns.id, id)).for('update');
      if (!c || c.tenantId !== ctx.tenantId) throw Errors.notFound('Campaign');
      if (c.version !== version) throw Errors.versionConflict(c.version);
      if (c.status !== 'draft')
        throw Errors.conflict('INVALID_STATE_TRANSITION', 'This campaign is already prepared');
      const [seg] = await tx.select().from(segments).where(eq(segments.id, c.segmentId));
      const def = SegmentDefinition.parse(seg!.definition);
      const now = new Date();
      const inSegment = segmentWhere(ctx.tenantId, def, now);
      const address =
        c.channel === 'email' ? sql<string>`"customers"."email"` : sql<string>`"customers"."phone"`;
      const reachable = and(
        inSegment,
        consentGranted(c.channel),
        c.channel === 'email' ? undefined : sql`"customers"."phone" is not null`,
      )!;
      const audience = await tx.select({ id: customers.id, address }).from(customers).where(reachable);
      const [{ n }] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(customers)
        .where(and(inSegment, not(reachable)))) as [{ n: number }];
      if (audience.length)
        await tx.insert(campaignRecipients).values(
          audience.map((a) => ({
            tenantId: ctx.tenantId,
            campaignId: c.id,
            customerId: a.id,
            address: a.address,
            statusReason: SEND_BLOCKED_REASON,
          })),
        );
      const [after] = await tx
        .update(campaigns)
        .set({
          status: 'prepared',
          preparedAt: now,
          preparedBy: auth.userId,
          recipientCount: audience.length,
          excludedNoConsent: n,
          version: c.version + 1,
          updatedAt: now,
        })
        .where(eq(campaigns.id, c.id))
        .returning();
      await this.audit(tx, auth, ctx, meta, 'marketing.campaign_prepared', 'campaign', c.id, {
        recipients: audience.length,
        excludedNoConsent: n,
      });
      return (await this.toCampaigns(tx, [after!]))[0]!;
    });
  }

  async recipients(ctx: TenantState, id: string, q: z.infer<typeof PageQuery>) {
    requireMarketing(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [c] = await tx
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(and(eq(campaigns.id, id), eq(campaigns.tenantId, ctx.tenantId)));
      if (!c) throw Errors.notFound('Campaign');
      const rows = await tx
        .select({
          id: campaignRecipients.id,
          customerId: campaignRecipients.customerId,
          address: campaignRecipients.address,
          status: campaignRecipients.status,
          statusReason: campaignRecipients.statusReason,
        })
        .from(campaignRecipients)
        .where(
          and(
            eq(campaignRecipients.campaignId, id),
            cursor ? gt(campaignRecipients.id, cursor.id) : undefined,
          ),
        )
        .orderBy(asc(campaignRecipients.id))
        .limit(q.limit + 1);
      const hasMore = rows.length > q.limit;
      const items = rows.slice(0, q.limit);
      return { items, nextCursor: hasMore ? encodeCursor(null, items.at(-1)!.id) : null };
    });
  }
}
