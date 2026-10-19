import { Injectable } from '@nestjs/common';
import type {
  Company,
  CompanyListQuery,
  CompanySummary,
  CreateCompanyLocationRequest,
  CreateCompanyRequest,
  CreditEntry,
  InviteBuyerRequest,
  Page,
  PageQuery,
  RecordCreditEntryRequest,
  UpdateBuyerRequest,
  UpdateCompanyLocationRequest,
  UpdateCompanyRequest,
} from '@uc/contracts';
import {
  collections,
  companies,
  companyBuyers,
  companyLocations,
  creditEntries,
  generateToken,
  memberships,
  priceBooks,
  sha256,
  tenants,
  users,
  writeAudit,
  type Tx,
} from '@uc/db';
import { and, asc, desc, eq, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { decodeCursor, paginate } from '../../common/cursor';
import { AppError, Errors } from '../../common/errors';
import { iso, likePattern } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';
import {
  creditSummary,
  exposureOf,
  loadCompany,
  repFilter,
  requireB2b,
  toBuyers,
  toLocation,
  type CompanyRow,
} from './b2b.common';

const INVITE_DAYS = 7;

@Injectable()
export class CompaniesService {
  constructor(private readonly db: DbService) {}

  private audit(
    tx: Tx,
    auth: AuthState,
    ctx: TenantState,
    meta: RequestMeta,
    action: string,
    entityType: string,
    id: string,
    values: {
      oldValues?: Record<string, unknown> | null;
      newValues?: Record<string, unknown> | null;
      reason?: string | null;
    },
  ) {
    return writeAudit(tx, {
      tenantId: ctx.tenantId,
      actorType: 'user',
      actorUserId: auth.userId,
      action,
      entityType,
      entityId: id,
      oldValues: values.oldValues ?? null,
      newValues: values.newValues ?? null,
      reason: values.reason ?? null,
      correlationId: meta.correlationId,
      ip: meta.ip,
    });
  }

  private async toCompany(tx: Tx, c: CompanyRow): Promise<Company> {
    const [locs, buyers, rep, book] = await Promise.all([
      tx
        .select()
        .from(companyLocations)
        .where(eq(companyLocations.companyId, c.id))
        .orderBy(asc(companyLocations.name)),
      tx
        .select()
        .from(companyBuyers)
        .where(eq(companyBuyers.companyId, c.id))
        .orderBy(asc(companyBuyers.email)),
      c.salesRepUserId
        ? tx
            .select({ id: users.id, name: users.displayName })
            .from(users)
            .where(eq(users.id, c.salesRepUserId))
        : Promise.resolve([]),
      c.priceBookId
        ? tx
            .select({ id: priceBooks.id, name: priceBooks.name })
            .from(priceBooks)
            .where(eq(priceBooks.id, c.priceBookId))
        : Promise.resolve([]),
    ]);
    return {
      id: c.id,
      name: c.name,
      code: c.code,
      gstin: c.gstin,
      status: c.status,
      paymentTerms: c.paymentTerms,
      creditLimitMinor: c.creditLimitMinor === null ? null : c.creditLimitMinor.toString(),
      minOrderMinor: c.minOrderMinor === null ? null : c.minOrderMinor.toString(),
      accountingAuthority: c.accountingAuthority,
      salesRep: rep[0] ?? null,
      priceBook: book[0] ?? null,
      catalogMode: c.catalogMode,
      collectionIds: c.collectionIds,
      notes: c.notes,
      credit: await creditSummary(tx, c),
      locations: locs.map(toLocation),
      buyers: await toBuyers(tx, buyers),
      version: c.version,
      createdAt: iso(c.createdAt),
    };
  }

  /** Referenced rep, book and collections must belong to this tenant. */
  private async checkRefs(
    tx: Tx,
    tenantId: string,
    input: { salesRepUserId?: string | null; priceBookId?: string | null; collectionIds?: string[] },
  ) {
    if (input.salesRepUserId) {
      const [m] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.tenantId, tenantId),
            eq(memberships.userId, input.salesRepUserId),
            eq(memberships.status, 'active'),
          ),
        );
      if (!m)
        throw Errors.validation([{ path: 'salesRepUserId', message: 'Must be an active staff member' }]);
    }
    if (input.priceBookId) {
      const [b] = await tx
        .select({ id: priceBooks.id })
        .from(priceBooks)
        .where(and(eq(priceBooks.tenantId, tenantId), eq(priceBooks.id, input.priceBookId)));
      if (!b) throw Errors.validation([{ path: 'priceBookId', message: 'Unknown price book' }]);
    }
    if (input.collectionIds?.length) {
      const found = await tx
        .select({ id: collections.id })
        .from(collections)
        .where(and(eq(collections.tenantId, tenantId), inArray(collections.id, input.collectionIds)));
      if (found.length !== new Set(input.collectionIds).size)
        throw Errors.validation([{ path: 'collectionIds', message: 'Unknown collection' }]);
    }
  }

  async list(auth: AuthState, ctx: TenantState, q: CompanyListQuery): Promise<Page<CompanySummary>> {
    requireB2b(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const rep = repFilter(ctx, auth.userId);
      const where: (SQL | undefined)[] = [
        eq(companies.tenantId, ctx.tenantId),
        q.status ? eq(companies.status, q.status) : undefined,
        rep ? eq(companies.salesRepUserId, rep) : undefined,
        q.q
          ? or(ilike(companies.name, likePattern(q.q)), ilike(companies.code, likePattern(q.q)))
          : undefined,
      ];
      if (cursor)
        where.push(
          or(
            sql`${companies.name} > ${String(cursor.sortValue)}`,
            and(eq(companies.name, String(cursor.sortValue)), sql`${companies.id} > ${cursor.id}`),
          ),
        );
      const rows = await tx
        .select({
          c: companies,
          rep: users.displayName,
          buyers: sql<number>`(select count(*)::int from ${companyBuyers} b where b.company_id = ${companies.id} and b.status <> 'disabled')`,
          exposure: sql<string>`(select coalesce(sum(e.amount_minor), 0)::text from ${creditEntries} e where e.company_id = ${companies.id})`,
        })
        .from(companies)
        .leftJoin(users, eq(users.id, companies.salesRepUserId))
        .where(and(...where))
        .orderBy(asc(companies.name), asc(companies.id))
        .limit(q.limit + 1);
      return paginate(
        rows.map((r) => ({
          id: r.c.id,
          name: r.c.name,
          code: r.c.code,
          status: r.c.status,
          paymentTerms: r.c.paymentTerms,
          salesRep: r.c.salesRepUserId ? { id: r.c.salesRepUserId, name: r.rep ?? '' } : null,
          createdAt: iso(r.c.createdAt),
          buyerCount: r.buyers,
          exposureMinor: r.exposure,
          currency: r.c.currency,
        })),
        q.limit,
        (r) => r.name,
      );
    });
  }

  async get(auth: AuthState, ctx: TenantState, id: string): Promise<Company> {
    requireB2b(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) =>
      this.toCompany(tx, await loadCompany(tx, ctx, auth.userId, id)),
    );
  }

  async create(
    auth: AuthState,
    ctx: TenantState,
    input: CreateCompanyRequest,
    meta: RequestMeta,
  ): Promise<Company> {
    requireB2b(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await this.checkRefs(tx, ctx.tenantId, input);
      const [t] = await tx
        .select({ currency: tenants.defaultCurrency })
        .from(tenants)
        .where(eq(tenants.id, ctx.tenantId));
      const [row] = await tx
        .insert(companies)
        .values({
          tenantId: ctx.tenantId,
          name: input.name,
          code: input.code,
          gstin: input.gstin ?? null,
          paymentTerms: input.paymentTerms ?? 'on_account',
          currency: t!.currency,
          creditLimitMinor: input.creditLimitMinor ? BigInt(input.creditLimitMinor) : null,
          minOrderMinor: input.minOrderMinor ? BigInt(input.minOrderMinor) : null,
          accountingAuthority: input.accountingAuthority ?? 'commerce',
          salesRepUserId: input.salesRepUserId ?? null,
          priceBookId: input.priceBookId ?? null,
          catalogMode: input.catalogMode ?? 'all',
          collectionIds: input.collectionIds ?? [],
          notes: input.notes ?? null,
          createdBy: auth.userId,
        })
        .returning();
      await this.audit(tx, auth, ctx, meta, 'company.created', 'company', row!.id, {
        newValues: { name: row!.name, code: row!.code, gstin: row!.gstin },
      });
      return this.toCompany(tx, row!);
    });
  }

  async update(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: UpdateCompanyRequest,
    meta: RequestMeta,
  ): Promise<Company> {
    requireB2b(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const before = await loadCompany(tx, ctx, auth.userId, id, true);
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      await this.checkRefs(tx, ctx.tenantId, input);
      const { version, creditLimitMinor, minOrderMinor, ...rest } = input;
      const [after] = await tx
        .update(companies)
        .set({
          ...rest,
          ...(creditLimitMinor !== undefined
            ? { creditLimitMinor: creditLimitMinor === null ? null : BigInt(creditLimitMinor) }
            : {}),
          ...(minOrderMinor !== undefined
            ? { minOrderMinor: minOrderMinor === null ? null : BigInt(minOrderMinor) }
            : {}),
          version: version + 1,
          updatedAt: new Date(),
        })
        .where(eq(companies.id, id))
        .returning();
      const pick = (c: CompanyRow) => ({
        status: c.status,
        paymentTerms: c.paymentTerms,
        creditLimitMinor: c.creditLimitMinor?.toString() ?? null,
        salesRepUserId: c.salesRepUserId,
        priceBookId: c.priceBookId,
        catalogMode: c.catalogMode,
      });
      await this.audit(tx, auth, ctx, meta, 'company.updated', 'company', id, {
        oldValues: pick(before),
        newValues: pick(after!),
      });
      return this.toCompany(tx, after!);
    });
  }

  // ---------------------------------------------------------------- locations

  async addLocation(
    auth: AuthState,
    ctx: TenantState,
    companyId: string,
    input: CreateCompanyLocationRequest,
    meta: RequestMeta,
  ) {
    requireB2b(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const c = await loadCompany(tx, ctx, auth.userId, companyId);
      const [row] = await tx
        .insert(companyLocations)
        .values({
          tenantId: ctx.tenantId,
          companyId: c.id,
          name: input.name,
          code: input.code,
          address: input.address,
        })
        .returning();
      await this.audit(tx, auth, ctx, meta, 'company.location_added', 'company', c.id, {
        newValues: { location: input.code },
      });
      return toLocation(row!);
    });
  }

  async updateLocation(
    auth: AuthState,
    ctx: TenantState,
    companyId: string,
    locationId: string,
    input: UpdateCompanyLocationRequest,
    meta: RequestMeta,
  ) {
    requireB2b(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const c = await loadCompany(tx, ctx, auth.userId, companyId);
      const [loc] = await tx
        .select()
        .from(companyLocations)
        .where(and(eq(companyLocations.companyId, c.id), eq(companyLocations.id, locationId)))
        .for('update');
      if (!loc) throw Errors.notFound('Location');
      if (loc.version !== input.version) throw Errors.versionConflict(loc.version);
      const { version, ...rest } = input;
      const [after] = await tx
        .update(companyLocations)
        .set({ ...rest, version: version + 1, updatedAt: new Date() })
        .where(eq(companyLocations.id, loc.id))
        .returning();
      await this.audit(tx, auth, ctx, meta, 'company.location_updated', 'company', c.id, {
        newValues: { location: loc.code, ...rest },
      });
      return toLocation(after!);
    });
  }

  // ---------------------------------------------------------------- buyers

  private async checkLocations(tx: Tx, companyId: string, ids: string[] | null | undefined) {
    if (!ids?.length) return;
    const found = await tx
      .select({ id: companyLocations.id })
      .from(companyLocations)
      .where(and(eq(companyLocations.companyId, companyId), inArray(companyLocations.id, ids)));
    if (found.length !== new Set(ids).size)
      throw Errors.validation([{ path: 'locationIds', message: 'Unknown company location' }]);
  }

  /** Creates (or re-issues) a buyer invitation. The token is shown once; only its hash is stored. */
  async inviteBuyer(
    auth: AuthState,
    ctx: TenantState,
    companyId: string,
    input: InviteBuyerRequest,
    meta: RequestMeta,
  ) {
    requireB2b(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const c = await loadCompany(tx, ctx, auth.userId, companyId);
      await this.checkLocations(tx, c.id, input.locationIds);
      const token = generateToken();
      const expiresAt = new Date(Date.now() + INVITE_DAYS * 24 * 3600_000);
      const [existing] = await tx
        .select()
        .from(companyBuyers)
        .where(and(eq(companyBuyers.companyId, c.id), eq(companyBuyers.email, input.email)));
      if (existing && existing.status !== 'invited')
        throw Errors.duplicate('email', `${input.email} is already a buyer of ${c.name}`);
      const values = {
        role: input.role,
        locationIds: input.locationIds,
        orderLimitMinor: input.orderLimitMinor === null ? null : BigInt(input.orderLimitMinor),
        invitationTokenHash: sha256(token),
        invitationExpiresAt: expiresAt,
        invitedBy: auth.userId,
      };
      const [row] = existing
        ? await tx
            .update(companyBuyers)
            .set({ ...values, version: existing.version + 1, updatedAt: new Date() })
            .where(eq(companyBuyers.id, existing.id))
            .returning()
        : await tx
            .insert(companyBuyers)
            .values({ tenantId: ctx.tenantId, companyId: c.id, email: input.email, ...values })
            .returning();
      await this.audit(tx, auth, ctx, meta, 'company.buyer_invited', 'company', c.id, {
        newValues: { email: input.email, role: input.role },
      });
      return {
        buyer: (await toBuyers(tx, [row!]))[0]!,
        invitationToken: token,
        invitationPath: `/accept-invite?token=${token}`,
        expiresAt: iso(expiresAt),
      };
    });
  }

  async updateBuyer(
    auth: AuthState,
    ctx: TenantState,
    companyId: string,
    buyerId: string,
    input: UpdateBuyerRequest,
    meta: RequestMeta,
  ) {
    requireB2b(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const c = await loadCompany(tx, ctx, auth.userId, companyId);
      const [b] = await tx
        .select()
        .from(companyBuyers)
        .where(and(eq(companyBuyers.companyId, c.id), eq(companyBuyers.id, buyerId)))
        .for('update');
      if (!b) throw Errors.notFound('Buyer');
      if (b.version !== input.version) throw Errors.versionConflict(b.version);
      if (input.status === 'active' && b.status === 'invited')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', 'The buyer has not accepted the invitation yet');
      await this.checkLocations(tx, c.id, input.locationIds);
      const { version, orderLimitMinor, ...rest } = input;
      const [after] = await tx
        .update(companyBuyers)
        .set({
          ...rest,
          ...(orderLimitMinor !== undefined
            ? { orderLimitMinor: orderLimitMinor === null ? null : BigInt(orderLimitMinor) }
            : {}),
          version: version + 1,
          updatedAt: new Date(),
        })
        .where(eq(companyBuyers.id, b.id))
        .returning();
      await this.audit(tx, auth, ctx, meta, 'company.buyer_updated', 'company', c.id, {
        oldValues: { email: b.email, role: b.role, status: b.status },
        newValues: { role: after!.role, status: after!.status },
      });
      return (await toBuyers(tx, [after!]))[0]!;
    });
  }

  // ---------------------------------------------------------------- credit ledger

  async credit(
    auth: AuthState,
    ctx: TenantState,
    companyId: string,
    q: PageQuery,
  ): Promise<Page<CreditEntry>> {
    requireB2b(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const c = await loadCompany(tx, ctx, auth.userId, companyId);
      const where: (SQL | undefined)[] = [eq(creditEntries.companyId, c.id)];
      if (cursor) {
        const at = new Date(String(cursor.sortValue));
        where.push(
          or(
            lt(creditEntries.createdAt, at),
            and(eq(creditEntries.createdAt, at), lt(creditEntries.id, cursor.id)),
          ),
        );
      }
      const rows = await tx
        .select({ e: creditEntries, actor: users.displayName })
        .from(creditEntries)
        .leftJoin(users, eq(users.id, creditEntries.actorUserId))
        .where(and(...where))
        .orderBy(desc(creditEntries.createdAt), desc(creditEntries.id))
        .limit(q.limit + 1);
      return paginate(
        rows.map(({ e, actor }) => ({
          id: e.id,
          type: e.type,
          amountMinor: e.amountMinor.toString(),
          reference: e.reference,
          orderId: e.orderId,
          note: e.note,
          actor: e.actorUserId ? { id: e.actorUserId, name: actor ?? '' } : null,
          createdAt: iso(e.createdAt),
        })),
        q.limit,
        (r) => r.createdAt,
      );
    });
  }

  /** Payments and advances reduce exposure; adjustments need a reason and can go either way. */
  async recordCredit(
    auth: AuthState,
    ctx: TenantState,
    companyId: string,
    input: RecordCreditEntryRequest,
    meta: RequestMeta,
  ) {
    requireB2b(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const c = await loadCompany(tx, ctx, auth.userId, companyId, true);
      const amount = BigInt(input.amountMinor);
      const signed = input.type === 'adjustment' ? amount : -amount;
      const [row] = await tx
        .insert(creditEntries)
        .values({
          tenantId: ctx.tenantId,
          companyId: c.id,
          type: input.type,
          amountMinor: signed,
          reference: input.reference,
          note: input.note,
          actorUserId: auth.userId,
        })
        .returning();
      await this.audit(tx, auth, ctx, meta, `company.credit_${input.type}`, 'company', c.id, {
        newValues: {
          amountMinor: signed.toString(),
          reference: input.reference,
          exposureMinor: (await exposureOf(tx, c.id)).toString(),
        },
        reason: input.note,
      });
      return { id: row!.id, credit: await creditSummary(tx, c) };
    });
  }
}
