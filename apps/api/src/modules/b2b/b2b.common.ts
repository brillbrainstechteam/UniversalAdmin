import type { CompanyBuyer, CompanyLocation, CreditSummary } from '@uc/contracts';
import { companies, companyBuyers, companyLocations, creditEntries, users, type Tx } from '@uc/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { AppError, Errors } from '../../common/errors';
import { iso } from '../../common/mappers';
import type { TenantState } from '../../common/request';

export type CompanyRow = typeof companies.$inferSelect;
export type BuyerRow = typeof companyBuyers.$inferSelect;
export type LocationRow = typeof companyLocations.$inferSelect;

export function requireB2b(ctx: Pick<TenantState, 'features'>) {
  if (!ctx.features.includes('b2b_companies')) throw Errors.featureNotEntitled('b2b_companies');
}

/**
 * Members whose customer-facing access comes only from the sales-rep role see just their assigned companies
 * (and those companies' RFQs). Returns the user id to filter by, or null for unrestricted members.
 */
export function repFilter(ctx: TenantState, userId: string): string | null {
  const broad = ctx.isOwner || ctx.roleKeys.includes('admin') || ctx.permissions.has('companies.manage');
  return !broad && ctx.roleKeys.includes('sales_rep') ? userId : null;
}

export async function loadCompany(
  tx: Tx,
  ctx: TenantState,
  userId: string,
  id: string,
  lock = false,
): Promise<CompanyRow> {
  const q = tx
    .select()
    .from(companies)
    .where(and(eq(companies.tenantId, ctx.tenantId), eq(companies.id, id)));
  const [row] = lock ? await q.for('update') : await q;
  const rep = repFilter(ctx, userId);
  if (!row || (rep && row.salesRepUserId !== rep)) throw Errors.notFound('Company');
  return row;
}

/** Exposure = Σ ledger (+ owed, − paid/advanced). */
export async function exposureOf(tx: Tx, companyId: string): Promise<bigint> {
  const [r] = await tx
    .select({ total: sql<string>`coalesce(sum(${creditEntries.amountMinor}), 0)::text` })
    .from(creditEntries)
    .where(eq(creditEntries.companyId, companyId));
  return BigInt(r!.total);
}

/** Prepaid companies have an effective limit of 0: orders must be covered by advances already received. */
const effectiveLimit = (c: CompanyRow): bigint | null =>
  c.paymentTerms === 'prepaid' ? 0n : c.creditLimitMinor;

export async function creditSummary(tx: Tx, c: CompanyRow): Promise<CreditSummary> {
  const exposure = await exposureOf(tx, c.id);
  const limit = effectiveLimit(c);
  return {
    currency: c.currency,
    limitMinor: limit === null ? null : limit.toString(),
    exposureMinor: exposure.toString(),
    availableMinor: limit === null ? null : (limit - exposure).toString(),
    authority: c.accountingAuthority,
  };
}

/**
 * Before an on-account company order: the company row is locked (serialising concurrent orders of one company),
 * must be active, and exposure + total must stay within the (effective) limit.
 */
export async function guardCompanyOrder(
  tx: Tx,
  tenantId: string,
  companyId: string,
  totalMinor: bigint,
): Promise<CompanyRow> {
  const [c] = await tx
    .select()
    .from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
    .for('update');
  if (!c) throw Errors.notFound('Company');
  if (c.status !== 'active')
    throw new AppError(
      409,
      'COMPANY_ON_HOLD',
      `${c.name} is ${c.status.replace('_', ' ')}: orders are not accepted`,
    );
  const limit = effectiveLimit(c);
  if (limit !== null) {
    const exposure = await exposureOf(tx, c.id);
    if (exposure + totalMinor > limit)
      throw new AppError(
        409,
        'CREDIT_LIMIT_EXCEEDED',
        c.paymentTerms === 'prepaid'
          ? `${c.name} pays in advance: the advance balance does not cover this order`
          : `This order would take ${c.name} over its credit limit`,
        {
          limitMinor: limit.toString(),
          exposureMinor: exposure.toString(),
          orderMinor: totalMinor.toString(),
          availableMinor: (limit - exposure).toString(),
        },
      );
  }
  return c;
}

/** Reserves the order's amount on the company's credit (released if the order is cancelled). */
export async function chargeCredit(
  tx: Tx,
  input: {
    tenantId: string;
    companyId: string;
    orderId: string;
    number: string;
    totalMinor: bigint;
    actorUserId: string | null;
  },
) {
  if (input.totalMinor <= 0n) return;
  await tx.insert(creditEntries).values({
    tenantId: input.tenantId,
    companyId: input.companyId,
    type: 'order_charge',
    amountMinor: input.totalMinor,
    reference: input.number,
    orderId: input.orderId,
    note: `Order ${input.number}`,
    actorUserId: input.actorUserId,
  });
}

export function toLocation(l: LocationRow): CompanyLocation {
  return {
    id: l.id,
    name: l.name,
    code: l.code,
    address: l.address as CompanyLocation['address'],
    status: l.status,
    version: l.version,
  };
}

export async function toBuyers(tx: Tx, rows: BuyerRow[]): Promise<CompanyBuyer[]> {
  const ids = rows.map((r) => r.userId).filter((x): x is string => !!x);
  const people = ids.length ? await tx.select().from(users).where(inArray(users.id, ids)) : [];
  return rows.map((b) => {
    const u = people.find((p) => p.id === b.userId);
    return {
      id: b.id,
      user: u ? { id: u.id, email: u.email, displayName: u.displayName } : null,
      email: b.email,
      role: b.role,
      locationIds: b.locationIds ?? null,
      orderLimitMinor: b.orderLimitMinor === null ? null : b.orderLimitMinor.toString(),
      status: b.status,
      invitationExpiresAt:
        b.status === 'invited' && b.invitationExpiresAt ? iso(b.invitationExpiresAt) : null,
      version: b.version,
    };
  });
}
