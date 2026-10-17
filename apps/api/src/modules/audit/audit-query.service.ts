import { Injectable } from '@nestjs/common';
import type { AuditEvent, AuditQuery, Page } from '@uc/contracts';
import { auditEvents, users, type Tx } from '@uc/db';
import { and, desc, eq, gte, isNull, lt, lte, or, type SQL } from 'drizzle-orm';
import { decodeCursor, paginate } from '../../common/cursor';
import { toAuditEvent } from '../../common/mappers';
import { DbService } from '../../db/db.service';

@Injectable()
export class AuditQueryService {
  constructor(private readonly db: DbService) {}

  private async query(tx: Tx, query: AuditQuery, scope: SQL | undefined): Promise<Page<AuditEvent>> {
    const cursor = decodeCursor(query.cursor);
    const conditions: (SQL | undefined)[] = [scope];
    if (query.action) conditions.push(eq(auditEvents.action, query.action));
    if (query.entityType) conditions.push(eq(auditEvents.entityType, query.entityType));
    if (query.entityId) conditions.push(eq(auditEvents.entityId, query.entityId));
    if (query.actorId) conditions.push(eq(auditEvents.actorUserId, query.actorId));
    if (query.from) conditions.push(gte(auditEvents.createdAt, new Date(query.from)));
    if (query.to) conditions.push(lte(auditEvents.createdAt, new Date(query.to)));
    if (cursor && typeof cursor.sortValue === 'string') {
      const at = new Date(cursor.sortValue);
      conditions.push(
        or(lt(auditEvents.createdAt, at), and(eq(auditEvents.createdAt, at), lt(auditEvents.id, cursor.id))),
      );
    }
    const rows = await tx
      .select({ event: auditEvents, actorEmail: users.email })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorUserId))
      .where(and(...conditions))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(query.limit + 1);
    const page = paginate(
      rows.map((r) => ({ id: r.event.id, row: r })),
      query.limit,
      (r) => r.row.event.createdAt.toISOString(),
    );
    return {
      items: page.items.map((r) => toAuditEvent(r.row.event, r.row.actorEmail)),
      nextCursor: page.nextCursor,
    };
  }

  forTenant(tenantId: string, query: AuditQuery): Promise<Page<AuditEvent>> {
    return this.db.tenant(tenantId, (tx) => this.query(tx, query, eq(auditEvents.tenantId, tenantId)));
  }

  /** Platform view: all tenants, or one tenant, or platform-level events (tenantId null). */
  forPlatform(query: AuditQuery & { tenantId?: string }): Promise<Page<AuditEvent>> {
    const scope = query.tenantId ? eq(auditEvents.tenantId, query.tenantId) : undefined;
    return this.db.system((tx) => this.query(tx, query, scope));
  }

  platformOnly(query: AuditQuery): Promise<Page<AuditEvent>> {
    return this.db.system((tx) => this.query(tx, query, isNull(auditEvents.tenantId)));
  }
}
