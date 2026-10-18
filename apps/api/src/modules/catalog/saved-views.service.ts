import { Injectable } from '@nestjs/common';
import type {
  CreateSavedViewRequest,
  ProductFilters,
  SavedView,
  UpdateSavedViewRequest,
} from '@uc/contracts';
import { savedViews, users } from '@uc/db';
import { and, asc, eq, or } from 'drizzle-orm';
import { Errors } from '../../common/errors';
import { iso } from '../../common/mappers';
import type { AuthState, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';

/** Saved list views: private to their owner unless shared; only the owner may change or delete. */
@Injectable()
export class SavedViewsService {
  constructor(private readonly db: DbService) {}

  private toView(row: typeof savedViews.$inferSelect, ownerEmail: string, auth: AuthState): SavedView {
    return {
      id: row.id,
      resource: 'products',
      name: row.name,
      filters: row.filters as ProductFilters,
      isShared: row.isShared,
      isOwn: row.userId === auth.userId,
      ownerEmail,
      version: row.version,
      updatedAt: iso(row.updatedAt),
    };
  }

  async list(auth: AuthState, ctx: TenantState): Promise<{ items: SavedView[] }> {
    const rows = await this.db.tenant(ctx.tenantId, (tx) =>
      tx
        .select({ v: savedViews, email: users.email })
        .from(savedViews)
        .innerJoin(users, eq(users.id, savedViews.userId))
        .where(
          and(
            eq(savedViews.tenantId, ctx.tenantId),
            eq(savedViews.resource, 'products'),
            or(eq(savedViews.userId, auth.userId), eq(savedViews.isShared, true)),
          ),
        )
        .orderBy(asc(savedViews.name)),
    );
    return { items: rows.map((r) => this.toView(r.v, r.email, auth)) };
  }

  async create(auth: AuthState, ctx: TenantState, input: CreateSavedViewRequest): Promise<SavedView> {
    const [row] = await this.db.tenant(ctx.tenantId, (tx) =>
      tx
        .insert(savedViews)
        .values({
          tenantId: ctx.tenantId,
          userId: auth.userId,
          resource: input.resource,
          name: input.name,
          filters: input.filters,
          isShared: input.isShared,
        })
        .returning(),
    );
    return this.toView(row!, auth.email, auth);
  }

  private async own(ctx: TenantState, auth: AuthState, id: string) {
    const [row] = await this.db.tenant(ctx.tenantId, (tx) =>
      tx
        .select()
        .from(savedViews)
        .where(
          and(
            eq(savedViews.tenantId, ctx.tenantId),
            eq(savedViews.id, id),
            eq(savedViews.userId, auth.userId),
          ),
        ),
    );
    // Other users' views (shared or not) are indistinguishable from missing ones for writes.
    if (!row) throw Errors.notFound('Saved view');
    return row;
  }

  async update(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: UpdateSavedViewRequest,
  ): Promise<SavedView> {
    const before = await this.own(ctx, auth, id);
    if (before.version !== input.version) throw Errors.versionConflict(before.version);
    const { version, ...changes } = input;
    const [after] = await this.db.tenant(ctx.tenantId, (tx) =>
      tx
        .update(savedViews)
        .set({ ...changes, version: version + 1, updatedAt: new Date() })
        .where(and(eq(savedViews.id, id), eq(savedViews.version, version)))
        .returning(),
    );
    if (!after) throw Errors.versionConflict();
    return this.toView(after, auth.email, auth);
  }

  async remove(auth: AuthState, ctx: TenantState, id: string): Promise<void> {
    await this.own(ctx, auth, id);
    await this.db.tenant(ctx.tenantId, (tx) => tx.delete(savedViews).where(eq(savedViews.id, id)));
  }
}
