import { Injectable } from '@nestjs/common';
import type {
  CreateReturnRequest,
  CustomerAddress,
  CustomerMe,
  CustomerOrder,
  Page,
  PageQuery,
  SaveAddressRequest,
  UpdateAddressRequest,
  UpdatePreferencesRequest,
  UpdateProfileRequest,
  Address,
  z,
} from '@uc/contracts';
import {
  consentEvents,
  customerAddresses,
  customerMessages,
  customers,
  orderLines,
  orderSettings,
  orders,
  refunds,
  returns,
  shipmentLines,
  shipments,
  type Tx,
} from '@uc/db';
import { and, asc, desc, eq, inArray, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { decodeCursor, paginate } from '../../common/cursor';
import { Errors } from '../../common/errors';
import { iso } from '../../common/mappers';
import type { RequestMeta } from '../../common/request';
import { DbService } from '../../db/db.service';
import { lineProgress, returnDeadline } from '../fulfillment/fulfillment.common';
import { ReturnsService } from '../fulfillment/returns.service';
import type { CustomerScope } from './customer-auth.service';
import { addressesOf, currentPreferences } from './customers.common';

type CustomerOrderSummary = Omit<
  CustomerOrder,
  'lines' | 'shippingAddress' | 'shipments' | 'returns' | 'refunds' | 'messages' | 'returnDeadline'
>;

/** The signed-in customer's own account (Phase 09). Every query is filtered by tenant AND customer id. */
@Injectable()
export class AccountService {
  constructor(private readonly db: DbService) {}

  async me(s: CustomerScope): Promise<CustomerMe> {
    return this.db.tenant(s.tenantId, async (tx) => {
      const [settings] = await tx.select().from(orderSettings).where(eq(orderSettings.tenantId, s.tenantId));
      const c = s.customer;
      return {
        customer: {
          id: c.id,
          email: c.email,
          displayName: c.displayName,
          phone: c.phone,
          emailVerified: !!c.emailVerifiedAt,
          version: c.version,
        },
        storefront: { name: s.storefrontName, currency: s.currency, isDemo: s.isDemo },
        preferences: await currentPreferences(tx, c.id),
        returnWindowDays: settings?.returnWindowDays ?? 14,
        sessionExpiresAt: iso(s.sessionExpiresAt),
      };
    });
  }

  async updateProfile(s: CustomerScope, input: UpdateProfileRequest): Promise<CustomerMe> {
    await this.db.tenant(s.tenantId, async (tx) => {
      const [c] = await tx.select().from(customers).where(eq(customers.id, s.customer.id)).for('update');
      if (c!.version !== input.version) throw Errors.versionConflict(c!.version);
      const { version, ...rest } = input;
      const [after] = await tx
        .update(customers)
        .set({ ...rest, version: version + 1, updatedAt: new Date() })
        .where(eq(customers.id, c!.id))
        .returning();
      s.customer = after!;
    });
    return this.me(s);
  }

  /** Appends a consent event only for channels whose preference actually changes. */
  async updatePreferences(
    s: CustomerScope,
    input: UpdatePreferencesRequest,
    meta: RequestMeta,
  ): Promise<CustomerMe> {
    await this.db.tenant(s.tenantId, async (tx) => {
      await tx
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.id, s.customer.id))
        .for('update');
      const now = await currentPreferences(tx, s.customer.id);
      const changes = (['email', 'sms', 'whatsapp'] as const).filter(
        (ch) => input[ch] !== undefined && input[ch] !== now[ch],
      );
      if (changes.length)
        await tx.insert(consentEvents).values(
          changes.map((channel) => ({
            tenantId: s.tenantId,
            customerId: s.customer.id,
            channel,
            purpose: 'marketing' as const,
            granted: input[channel]!,
            source: 'account' as const,
            ip: meta.ip,
          })),
        );
    });
    return this.me(s);
  }

  // ---------------------------------------------------------------- addresses

  async addresses(s: CustomerScope): Promise<{ items: CustomerAddress[] }> {
    return this.db.tenant(s.tenantId, async (tx) => ({ items: await addressesOf(tx, s.customer.id) }));
  }

  private async clearDefault(tx: Tx, s: CustomerScope) {
    await tx
      .update(customerAddresses)
      .set({ isDefault: false, version: sql`${customerAddresses.version} + 1`, updatedAt: new Date() })
      .where(and(eq(customerAddresses.customerId, s.customer.id), eq(customerAddresses.isDefault, true)));
  }

  async addAddress(s: CustomerScope, input: SaveAddressRequest): Promise<{ items: CustomerAddress[] }> {
    return this.db.tenant(s.tenantId, async (tx) => {
      const [{ n }] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(customerAddresses)
        .where(eq(customerAddresses.customerId, s.customer.id))) as [{ n: number }];
      if (n >= 20) throw Errors.unprocessable('VALIDATION_FAILED', 'You can save up to 20 addresses');
      const makeDefault = input.isDefault || n === 0;
      if (makeDefault) await this.clearDefault(tx, s);
      await tx.insert(customerAddresses).values({
        tenantId: s.tenantId,
        customerId: s.customer.id,
        label: input.label,
        address: input.address,
        isDefault: makeDefault,
      });
      return { items: await addressesOf(tx, s.customer.id) };
    });
  }

  private async ownAddress(tx: Tx, s: CustomerScope, id: string) {
    const [a] = await tx
      .select()
      .from(customerAddresses)
      .where(and(eq(customerAddresses.id, id), eq(customerAddresses.customerId, s.customer.id)))
      .for('update');
    if (!a || a.tenantId !== s.tenantId) throw Errors.notFound('Address');
    return a;
  }

  async updateAddress(
    s: CustomerScope,
    id: string,
    input: UpdateAddressRequest,
  ): Promise<{ items: CustomerAddress[] }> {
    return this.db.tenant(s.tenantId, async (tx) => {
      const a = await this.ownAddress(tx, s, id);
      if (a.version !== input.version) throw Errors.versionConflict(a.version);
      if (input.isDefault && !a.isDefault) await this.clearDefault(tx, s);
      await tx
        .update(customerAddresses)
        .set({
          label: input.label,
          address: input.address,
          isDefault: input.isDefault || a.isDefault,
          version: a.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(customerAddresses.id, a.id));
      return { items: await addressesOf(tx, s.customer.id) };
    });
  }

  async deleteAddress(s: CustomerScope, id: string): Promise<{ items: CustomerAddress[] }> {
    return this.db.tenant(s.tenantId, async (tx) => {
      const a = await this.ownAddress(tx, s, id);
      await tx.delete(customerAddresses).where(eq(customerAddresses.id, a.id));
      return { items: await addressesOf(tx, s.customer.id) };
    });
  }

  // ---------------------------------------------------------------- orders

  private summary(o: typeof orders.$inferSelect, lineCount: number): CustomerOrderSummary {
    return {
      id: o.id,
      number: o.number,
      status: o.status,
      paymentStatus: o.paymentStatus,
      fulfillmentStatus: o.fulfillmentStatus,
      currency: o.currency,
      totalMinor: o.totalMinor.toString(),
      lineCount,
      createdAt: iso(o.createdAt),
    };
  }

  async orders(s: CustomerScope, q: z.infer<typeof PageQuery>): Promise<Page<CustomerOrderSummary>> {
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(s.tenantId, async (tx) => {
      const where: (SQL | undefined)[] = [
        eq(orders.tenantId, s.tenantId),
        eq(orders.customerId, s.customer.id),
      ];
      if (cursor) {
        const t = new Date(String(cursor.sortValue));
        where.push(or(lt(orders.createdAt, t), and(eq(orders.createdAt, t), lt(orders.id, cursor.id))));
      }
      const rows = await tx
        .select({
          o: orders,
          n: sql<number>`(select count(*)::int from order_lines ol where ol.order_id = "orders"."id")`,
        })
        .from(orders)
        .where(and(...where))
        .orderBy(desc(orders.createdAt), desc(orders.id))
        .limit(q.limit + 1);
      const page = paginate(
        rows.map((r) => ({ ...r, id: r.o.id })),
        q.limit,
        (r) => r.o.createdAt.toISOString(),
      );
      return { items: page.items.map((r) => this.summary(r.o, r.n)), nextCursor: page.nextCursor };
    });
  }

  private async ownOrder(tx: Tx, s: CustomerScope, id: string, lock = false) {
    const q = tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.tenantId, s.tenantId), eq(orders.customerId, s.customer.id)));
    const [o] = lock ? await q.for('update') : await q;
    if (!o) throw Errors.notFound('Order');
    return o;
  }

  private async view(tx: Tx, s: CustomerScope, o: typeof orders.$inferSelect): Promise<CustomerOrder> {
    const lines = await tx
      .select()
      .from(orderLines)
      .where(eq(orderLines.orderId, o.id))
      .orderBy(asc(orderLines.lineNo));
    const progress = await lineProgress(tx, lines);
    const ships = await tx
      .select()
      .from(shipments)
      .where(and(eq(shipments.orderId, o.id), inArray(shipments.status, ['shipped', 'delivered'])))
      .orderBy(asc(shipments.createdAt));
    const sl = ships.length
      ? await tx
          .select()
          .from(shipmentLines)
          .where(
            inArray(
              shipmentLines.shipmentId,
              ships.map((x) => x.id),
            ),
          )
      : [];
    const rets = await tx
      .select()
      .from(returns)
      .where(eq(returns.orderId, o.id))
      .orderBy(asc(returns.createdAt));
    const retValues = rets.length
      ? await tx.execute<{ return_id: string; v: string }>(
          sql`select return_id, sum(value_minor)::text as v from return_lines where return_id in (${sql.join(
            rets.map((r) => sql`${r.id}::uuid`),
            sql`, `,
          )}) group by 1`,
        )
      : { rows: [] };
    const refs = await tx
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, o.id))
      .orderBy(asc(refunds.createdAt));
    const msgs = await tx
      .select()
      .from(customerMessages)
      .where(eq(customerMessages.orderId, o.id))
      .orderBy(asc(customerMessages.createdAt));
    const deadline = await returnDeadline(tx, s.tenantId, ships);
    return {
      ...this.summary(o, lines.length),
      lines: lines.map((l) => {
        const p = progress.get(l.id)!;
        return {
          lineNo: l.lineNo,
          sku: l.sku,
          title: l.title,
          serialTag: l.serialTag,
          quantity: l.quantity,
          totalMinor: l.totalMinor.toString(),
          shippedQuantity: p.shipped,
          returnableQuantity: Math.max(0, p.shipped - p.inReturn),
        };
      }),
      shippingAddress: (o.shippingAddress as Address | null) ?? null,
      shipments: ships.map((x) => ({
        number: x.number,
        status: x.status as 'shipped' | 'delivered',
        carrier: x.carrier,
        trackingNumber: x.trackingNumber,
        trackingManual: true as const,
        shippedAt: x.shippedAt ? iso(x.shippedAt) : null,
        deliveredAt: x.deliveredAt ? iso(x.deliveredAt) : null,
        lines: sl
          .filter((y) => y.shipmentId === x.id)
          .map((y) => ({ lineNo: lines.find((l) => l.id === y.orderLineId)!.lineNo, quantity: y.quantity })),
      })),
      returns: rets.map((r) => ({
        id: r.id,
        number: r.number,
        status: r.status,
        reason: r.reason,
        valueMinor: retValues.rows.find((v) => v.return_id === r.id)?.v ?? '0',
        createdAt: iso(r.createdAt),
        decisionNote: r.decisionNote,
      })),
      refunds: refs.map((r) => ({
        amountMinor: r.amountMinor.toString(),
        status: r.status,
        createdAt: iso(r.createdAt),
      })),
      messages: msgs.map((m) => ({ subject: m.subject, status: m.status, createdAt: iso(m.createdAt) })),
      returnDeadline: deadline ? iso(deadline) : null,
    };
  }

  async order(s: CustomerScope, id: string): Promise<CustomerOrder> {
    return this.db.tenant(s.tenantId, async (tx) => this.view(tx, s, await this.ownOrder(tx, s, id)));
  }

  async requestReturn(
    s: CustomerScope,
    id: string,
    input: CreateReturnRequest,
    meta: RequestMeta,
  ): Promise<CustomerOrder> {
    if (!s.features.includes('fulfillment')) throw Errors.featureNotEntitled('fulfillment');
    return this.db.tenant(s.tenantId, async (tx) => {
      const o = await this.ownOrder(tx, s, id, true);
      const open = await tx
        .select({ id: returns.id })
        .from(returns)
        .where(
          and(eq(returns.orderId, o.id), ne(returns.status, 'received'), ne(returns.status, 'rejected')),
        );
      if (open.length >= 5)
        throw Errors.conflict('INVALID_STATE_TRANSITION', 'This order already has several open returns');
      await ReturnsService.createReturn(tx, {
        tenantId: s.tenantId,
        order: o,
        request: input,
        requestedBy: 'customer',
        userId: null,
        customerId: s.customer.id,
        correlationId: meta.correlationId,
      });
      return this.view(tx, s, o);
    });
  }
}
