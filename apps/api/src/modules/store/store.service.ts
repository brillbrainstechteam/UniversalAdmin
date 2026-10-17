import { Injectable } from '@nestjs/common';
import {
  CHANNEL_TYPES,
  type Channel,
  type CreateChannelRequest,
  type CreateStoreRequest,
  type Page,
  type PresetKey,
  type Store,
  type UpdateChannelRequest,
  type UpdateStoreRequest,
  type z,
  type ChannelListQuery,
  type StoreListQuery,
} from '@uc/contracts';
import { channelDomains, channels, defaultTheme, diff, stores, tenants, writeAudit, type Tx } from '@uc/db';
import { and, asc, eq, gt, ilike, inArray, or, type SQL } from 'drizzle-orm';
import { decodeCursor, paginate } from '../../common/cursor';
import { Errors } from '../../common/errors';
import { likePattern, toChannel, toStore } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';

type StoreQuery = z.infer<typeof StoreListQuery>;
type ChannelQuery = z.infer<typeof ChannelListQuery>;

@Injectable()
export class StoreService {
  constructor(private readonly db: DbService) {}

  private audit(
    tx: Tx,
    auth: AuthState,
    ctx: TenantState,
    meta: RequestMeta,
    action: string,
    entityType: string,
    entityId: string,
    values: { oldValues: Record<string, unknown> | null; newValues: Record<string, unknown> | null },
  ) {
    return writeAudit(tx, {
      tenantId: ctx.tenantId,
      actorType: 'user',
      actorUserId: auth.userId,
      action,
      entityType,
      entityId,
      ...values,
      correlationId: meta.correlationId,
      ip: meta.ip,
    });
  }

  // ---------------------------------------------------------------- stores

  async listStores(ctx: TenantState, query: StoreQuery): Promise<Page<Store>> {
    const cursor = decodeCursor(query.cursor);
    const where: (SQL | undefined)[] = [eq(stores.tenantId, ctx.tenantId)];
    if (query.q)
      where.push(or(ilike(stores.name, likePattern(query.q)), ilike(stores.code, likePattern(query.q))));
    if (query.status) where.push(eq(stores.status, query.status));
    if (cursor) {
      where.push(
        or(
          gt(stores.code, String(cursor.sortValue)),
          and(eq(stores.code, String(cursor.sortValue)), gt(stores.id, cursor.id)),
        ),
      );
    }
    const rows = await this.db.tenant(ctx.tenantId, (tx) =>
      tx
        .select()
        .from(stores)
        .where(and(...where))
        .orderBy(asc(stores.code), asc(stores.id))
        .limit(query.limit + 1),
    );
    const page = paginate(rows, query.limit, (r) => r.code);
    return { items: page.items.map(toStore), nextCursor: page.nextCursor };
  }

  private async findStore(tx: Tx, ctx: TenantState, id: string) {
    const [row] = await tx
      .select()
      .from(stores)
      .where(and(eq(stores.tenantId, ctx.tenantId), eq(stores.id, id)));
    if (!row) throw Errors.notFound('Store');
    return row;
  }

  async getStore(ctx: TenantState, id: string): Promise<Store> {
    return this.db.tenant(ctx.tenantId, async (tx) => toStore(await this.findStore(tx, ctx, id)));
  }

  async createStore(
    auth: AuthState,
    ctx: TenantState,
    input: CreateStoreRequest,
    meta: RequestMeta,
  ): Promise<Store> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, ctx.tenantId));
      const [row] = await tx
        .insert(stores)
        .values({
          tenantId: ctx.tenantId,
          code: input.code,
          name: input.name,
          defaultCurrency: input.defaultCurrency ?? tenant!.defaultCurrency,
          timezone: input.timezone ?? tenant!.timezone,
        })
        .returning();
      const store = toStore(row!);
      await this.audit(tx, auth, ctx, meta, 'store.created', 'store', store.id, {
        oldValues: null,
        newValues: store,
      });
      return store;
    });
  }

  async updateStore(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: UpdateStoreRequest,
    meta: RequestMeta,
  ): Promise<Store> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const before = await this.findStore(tx, ctx, id);
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      const { version, ...changes } = input;
      const [after] = await tx
        .update(stores)
        .set({ ...changes, version: version + 1, updatedAt: new Date() })
        .where(and(eq(stores.tenantId, ctx.tenantId), eq(stores.id, id), eq(stores.version, version)))
        .returning();
      if (!after) throw Errors.versionConflict();
      await this.audit(
        tx,
        auth,
        ctx,
        meta,
        'store.updated',
        'store',
        id,
        diff(toStore(before), toStore(after)),
      );
      return toStore(after);
    });
  }

  // ---------------------------------------------------------------- channels

  private async withDomains(
    tx: Tx,
    ctx: TenantState,
    rows: (typeof channels.$inferSelect)[],
  ): Promise<Channel[]> {
    if (rows.length === 0) return [];
    const domains = await tx
      .select()
      .from(channelDomains)
      .where(
        and(
          eq(channelDomains.tenantId, ctx.tenantId),
          inArray(
            channelDomains.channelId,
            rows.map((r) => r.id),
          ),
        ),
      );
    return rows.map((r) => toChannel(r, domains));
  }

  async listChannels(ctx: TenantState, query: ChannelQuery): Promise<Page<Channel>> {
    const cursor = decodeCursor(query.cursor);
    const where: (SQL | undefined)[] = [eq(channels.tenantId, ctx.tenantId)];
    if (query.storeId) where.push(eq(channels.storeId, query.storeId));
    if (query.type) where.push(eq(channels.type, query.type));
    if (query.status) where.push(eq(channels.status, query.status));
    if (cursor) {
      where.push(
        or(
          gt(channels.code, String(cursor.sortValue)),
          and(eq(channels.code, String(cursor.sortValue)), gt(channels.id, cursor.id)),
        ),
      );
    }
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(channels)
        .where(and(...where))
        .orderBy(asc(channels.code), asc(channels.id))
        .limit(query.limit + 1);
      const page = paginate(rows, query.limit, (r) => r.code);
      return { items: await this.withDomains(tx, ctx, page.items), nextCursor: page.nextCursor };
    });
  }

  private async findChannel(tx: Tx, ctx: TenantState, id: string) {
    const [row] = await tx
      .select()
      .from(channels)
      .where(and(eq(channels.tenantId, ctx.tenantId), eq(channels.id, id)));
    if (!row) throw Errors.notFound('Channel');
    return row;
  }

  async getChannel(ctx: TenantState, id: string): Promise<Channel> {
    return this.db.tenant(
      ctx.tenantId,
      async (tx) => (await this.withDomains(tx, ctx, [await this.findChannel(tx, ctx, id)]))[0]!,
    );
  }

  async createChannel(
    auth: AuthState,
    ctx: TenantState,
    input: CreateChannelRequest,
    meta: RequestMeta,
  ): Promise<Channel> {
    const requiredFeature = CHANNEL_TYPES[input.type].feature;
    if (!ctx.features.includes(requiredFeature)) throw Errors.featureNotEntitled(requiredFeature);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await this.findStore(tx, ctx, input.storeId); // 404 if store belongs to another tenant
      const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, ctx.tenantId));
      const [row] = await tx
        .insert(channels)
        .values({
          tenantId: ctx.tenantId,
          storeId: input.storeId,
          code: input.code,
          name: input.name,
          type: input.type,
          theme: input.theme ?? defaultTheme(tenant!.preset as PresetKey, tenant!.displayName),
        })
        .returning();
      const channel = toChannel(row!, []);
      await this.audit(tx, auth, ctx, meta, 'channel.created', 'channel', channel.id, {
        oldValues: null,
        newValues: channel,
      });
      return channel;
    });
  }

  async updateChannel(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: UpdateChannelRequest,
    meta: RequestMeta,
  ): Promise<Channel> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const before = await this.findChannel(tx, ctx, id);
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      const { version, ...changes } = input;
      const [after] = await tx
        .update(channels)
        .set({ ...changes, version: version + 1, updatedAt: new Date() })
        .where(and(eq(channels.tenantId, ctx.tenantId), eq(channels.id, id), eq(channels.version, version)))
        .returning();
      if (!after) throw Errors.versionConflict();
      await this.audit(
        tx,
        auth,
        ctx,
        meta,
        'channel.updated',
        'channel',
        id,
        diff(toChannel(before, []), toChannel(after, [])),
      );
      return (await this.withDomains(tx, ctx, [after]))[0]!;
    });
  }
}
