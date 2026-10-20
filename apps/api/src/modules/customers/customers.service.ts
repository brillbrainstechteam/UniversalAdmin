import { Injectable } from '@nestjs/common';
import type {
  CustomerDetail,
  CustomerListQuery,
  CustomerSummary,
  Page,
  UpdateCustomerStatusRequest,
} from '@uc/contracts';
import { customerSessions, customers, writeAudit, type Tx } from '@uc/db';
import { and, desc, eq, ilike, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { decodeCursor, paginate } from '../../common/cursor';
import { Errors } from '../../common/errors';
import { iso, likePattern } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';
import { addressesOf, consentHistory, currentPreferences } from './customers.common';

type Row = typeof customers.$inferSelect;

function requireCustomers(ctx: Pick<TenantState, 'features'>) {
  if (!ctx.features.includes('customers')) throw Errors.featureNotEntitled('customers');
}

/** Staff view of storefront customers (Phase 09). Password hashes never leave this service. */
@Injectable()
export class CustomersService {
  constructor(private readonly db: DbService) {}

  private summary(c: Row, orderCount: number): CustomerSummary {
    return {
      id: c.id,
      email: c.email,
      displayName: c.displayName,
      phone: c.phone,
      status: c.status,
      emailVerified: !!c.emailVerifiedAt,
      orderCount,
      isDemo: c.isDemo,
      lastLoginAt: c.lastLoginAt ? iso(c.lastLoginAt) : null,
      createdAt: iso(c.createdAt),
    };
  }

  // Explicit table name: inside the subquery an unqualified "id" would bind to orders.
  private orderCount = sql<number>`(select count(*)::int from orders o where o.customer_id = "customers"."id")`;

  async list(ctx: TenantState, q: CustomerListQuery): Promise<Page<CustomerSummary>> {
    requireCustomers(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const where: (SQL | undefined)[] = [
        eq(customers.tenantId, ctx.tenantId),
        q.status ? eq(customers.status, q.status) : undefined,
      ];
      if (q.q)
        where.push(
          or(ilike(customers.email, likePattern(q.q)), ilike(customers.displayName, likePattern(q.q))),
        );
      if (cursor) {
        const t = new Date(String(cursor.sortValue));
        where.push(
          or(lt(customers.createdAt, t), and(eq(customers.createdAt, t), lt(customers.id, cursor.id))),
        );
      }
      const rows = await tx
        .select({ c: customers, n: this.orderCount })
        .from(customers)
        .where(and(...where))
        .orderBy(desc(customers.createdAt), desc(customers.id))
        .limit(q.limit + 1);
      const page = paginate(
        rows.map((r) => ({ ...r, id: r.c.id })),
        q.limit,
        (r) => r.c.createdAt.toISOString(),
      );
      return { items: page.items.map((r) => this.summary(r.c, r.n)), nextCursor: page.nextCursor };
    });
  }

  private async detail(tx: Tx, c: Row): Promise<CustomerDetail> {
    const [{ n }] = (await tx
      .select({ n: this.orderCount })
      .from(customers)
      .where(eq(customers.id, c.id))) as [{ n: number }];
    return {
      ...this.summary(c, n),
      preferences: await currentPreferences(tx, c.id),
      consentHistory: await consentHistory(tx, c.id),
      addresses: await addressesOf(tx, c.id),
      version: c.version,
    };
  }

  private async load(tx: Tx, ctx: TenantState, id: string, lock = false) {
    const q = tx.select().from(customers).where(eq(customers.id, id));
    const [c] = lock ? await q.for('update') : await q;
    if (!c || c.tenantId !== ctx.tenantId) throw Errors.notFound('Customer');
    return c;
  }

  async get(ctx: TenantState, id: string): Promise<CustomerDetail> {
    requireCustomers(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => this.detail(tx, await this.load(tx, ctx, id)));
  }

  /** Disabling also ends every session of the customer. */
  async setStatus(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: UpdateCustomerStatusRequest,
    meta: RequestMeta,
  ): Promise<CustomerDetail> {
    requireCustomers(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const c = await this.load(tx, ctx, id, true);
      if (c.version !== input.version) throw Errors.versionConflict(c.version);
      const [after] = await tx
        .update(customers)
        .set({ status: input.status, version: c.version + 1, updatedAt: new Date() })
        .where(eq(customers.id, c.id))
        .returning();
      if (input.status === 'disabled')
        await tx
          .update(customerSessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(customerSessions.customerId, c.id), isNull(customerSessions.revokedAt)));
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: 'customers.status_changed',
        entityType: 'customer',
        entityId: c.id,
        oldValues: { status: c.status },
        newValues: { status: input.status },
        reason: input.reason,
        correlationId: meta.correlationId,
        ip: meta.ip,
      });
      return this.detail(tx, after!);
    });
  }
}
