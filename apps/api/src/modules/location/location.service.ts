import { Injectable } from '@nestjs/common';
import type {
  CreateLocationRequest,
  Location,
  LocationListQuery,
  Page,
  UpdateLocationRequest,
} from '@uc/contracts';
import { diff, locations, stores, writeAudit, type Tx } from '@uc/db';
import { and, asc, desc, eq, gt, ilike, inArray, lt, or, type AnyColumn, type SQL } from 'drizzle-orm';
import { decodeCursor, paginate } from '../../common/cursor';
import { AppError, Errors } from '../../common/errors';
import { likePattern, toLocation } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';
import { assertPlanCapacity } from '../launch/plans.service';

const SORTS: Record<string, { column: AnyColumn; key: 'code' | 'name' | 'createdAt' }> = {
  code: { column: locations.code, key: 'code' },
  name: { column: locations.name, key: 'name' },
  createdAt: { column: locations.createdAt, key: 'createdAt' },
};

const PARENT_TYPES: Record<string, string[]> = {
  bin: ['warehouse', 'branch', 'showroom'],
  warehouse: [],
  branch: [],
  showroom: ['branch'],
};

@Injectable()
export class LocationService {
  constructor(private readonly db: DbService) {}

  /** Members with a location scope only see/manage those locations (ADR-005). */
  private scopeCondition(ctx: TenantState): SQL | undefined {
    if (ctx.locationScope === null) return undefined;
    if (ctx.locationScope.length === 0) return eq(locations.id, '00000000-0000-0000-0000-000000000000');
    return inArray(locations.id, [...ctx.locationScope]);
  }

  async list(ctx: TenantState, query: LocationListQuery): Promise<Page<Location>> {
    const descending = query.sort.startsWith('-');
    const sort = SORTS[query.sort.replace('-', '')]!;
    const cursor = decodeCursor(query.cursor);
    const where: (SQL | undefined)[] = [eq(locations.tenantId, ctx.tenantId), this.scopeCondition(ctx)];
    if (query.q)
      where.push(
        or(ilike(locations.name, likePattern(query.q)), ilike(locations.code, likePattern(query.q))),
      );
    if (query.type) where.push(eq(locations.type, query.type));
    if (query.status) where.push(eq(locations.status, query.status));
    if (cursor) {
      const value = sort.key === 'createdAt' ? new Date(String(cursor.sortValue)) : String(cursor.sortValue);
      const cmp = descending ? lt : gt;
      where.push(or(cmp(sort.column, value), and(eq(sort.column, value), cmp(locations.id, cursor.id))));
    }
    const order = descending
      ? [desc(sort.column), desc(locations.id)]
      : [asc(sort.column), asc(locations.id)];
    const rows = await this.db.tenant(ctx.tenantId, (tx) =>
      tx
        .select()
        .from(locations)
        .where(and(...where))
        .orderBy(...order)
        .limit(query.limit + 1),
    );
    const page = paginate(rows, query.limit, (r) =>
      sort.key === 'createdAt' ? r.createdAt.toISOString() : r[sort.key],
    );
    return { items: page.items.map(toLocation), nextCursor: page.nextCursor };
  }

  private async find(tx: Tx, ctx: TenantState, id: string) {
    const [row] = await tx
      .select()
      .from(locations)
      .where(and(eq(locations.tenantId, ctx.tenantId), eq(locations.id, id), this.scopeCondition(ctx)));
    if (!row) throw Errors.notFound('Location');
    return row;
  }

  async get(ctx: TenantState, id: string): Promise<Location> {
    return this.db.tenant(ctx.tenantId, async (tx) => toLocation(await this.find(tx, ctx, id)));
  }

  async create(
    auth: AuthState,
    ctx: TenantState,
    input: CreateLocationRequest,
    meta: RequestMeta,
  ): Promise<Location> {
    if (ctx.locationScope !== null) {
      throw new AppError(
        403,
        'LOCATION_OUT_OF_SCOPE',
        'Members restricted to specific locations cannot create locations',
      );
    }
    return this.db.tenant(ctx.tenantId, async (tx) => {
      if (input.storeId) {
        const [store] = await tx
          .select({ id: stores.id })
          .from(stores)
          .where(and(eq(stores.tenantId, ctx.tenantId), eq(stores.id, input.storeId)));
        if (!store) throw Errors.notFound('Store');
      }
      if (input.parentId) {
        const parent = await this.find(tx, ctx, input.parentId);
        if (!PARENT_TYPES[input.type]?.includes(parent.type)) {
          throw Errors.validation([
            { path: 'parentId', message: `A ${input.type} cannot be placed under a ${parent.type}` },
          ]);
        }
      } else if (input.type === 'bin') {
        throw Errors.validation([
          { path: 'parentId', message: 'A bin must belong to a warehouse, branch or showroom' },
        ]);
      }
      await assertPlanCapacity(tx, ctx.tenantId, 'locations');
      const [row] = await tx
        .insert(locations)
        .values({
          tenantId: ctx.tenantId,
          code: input.code,
          name: input.name,
          type: input.type,
          storeId: input.storeId ?? null,
          parentId: input.parentId ?? null,
          address: input.address ?? null,
        })
        .returning();
      const location = toLocation(row!);
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: 'location.created',
        entityType: 'location',
        entityId: location.id,
        newValues: location,
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return location;
    });
  }

  async update(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: UpdateLocationRequest,
    meta: RequestMeta,
  ): Promise<Location> {
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const before = await this.find(tx, ctx, id);
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      const { version, ...changes } = input;
      const [after] = await tx
        .update(locations)
        .set({ ...changes, version: version + 1, updatedAt: new Date() })
        .where(
          and(eq(locations.tenantId, ctx.tenantId), eq(locations.id, id), eq(locations.version, version)),
        )
        .returning();
      if (!after) throw Errors.versionConflict();
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: auth.userId,
        action:
          changes.status && changes.status !== before.status
            ? `location.${changes.status === 'inactive' ? 'deactivated' : 'activated'}`
            : 'location.updated',
        entityType: 'location',
        entityId: id,
        ...diff(toLocation(before), toLocation(after)),
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return toLocation(after);
    });
  }
}
