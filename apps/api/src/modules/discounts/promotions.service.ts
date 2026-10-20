import { Injectable } from '@nestjs/common';
import {
  SegmentDefinition,
  currencyMinorUnits,
  formatMinor,
  planPromotions,
  type AppliedPromotions,
  type PromotionInput,
} from '@uc/contracts';
import { customers, discountRedemptions, discounts, segments, type Tx } from '@uc/db';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { segmentWhere } from '../marketing/segments.common';

type DiscountRow = typeof discounts.$inferSelect;

export interface PromotionContext {
  tenantId: string;
  channelId: string;
  customerId: string | null;
  code: string | null;
  now: Date;
  /** Lock the discount rows (checkout): usage limits are then checked against committed redemptions only. */
  lock?: boolean;
}

export interface Evaluated {
  promotions: (PromotionInput & { code: string | null; discountId: string })[];
  codeProblem: string | null;
}

const label = (d: DiscountRow) => (d.code ? `Code ${d.code}` : d.name);

/**
 * Decides which promotions apply to an order (Phase 10, ADR-025). All rules are evaluated on the server from the
 * stored discount: window, status, channel, currency, minimum subtotal, segment, usage limit and per-customer limit.
 * Combination: if every eligible promotion is combinable they all apply; otherwise only the single largest.
 */
@Injectable()
export class PromotionsService {
  private async why(
    tx: Tx,
    d: DiscountRow,
    ctx: PromotionContext,
    currency: string,
    baseMinor: bigint,
  ): Promise<string | null> {
    if (d.status !== 'active') return 'This code is not active';
    if (d.startsAt > ctx.now) return 'This code is not valid yet';
    if (d.endsAt && d.endsAt <= ctx.now) return 'This code has expired';
    if (d.channelIds.length && !d.channelIds.includes(ctx.channelId))
      return 'This code is not valid in this store';
    if (d.mode === 'fixed' && d.currency !== currency) return 'This code is not valid in this currency';
    if (d.usageLimit !== null && d.usedCount >= d.usageLimit) return 'This code has been used up';
    if (d.minSubtotalMinor !== null && baseMinor < d.minSubtotalMinor)
      return `Spend at least ${currency} ${formatMinor(d.minSubtotalMinor.toString(), currencyMinorUnits(currency))} to use this code`;
    if (d.perCustomerLimit !== null || d.segmentId !== null) {
      if (!ctx.customerId) return 'Sign in to use this code';
      if (d.perCustomerLimit !== null) {
        const [{ n }] = (await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(discountRedemptions)
          .where(
            and(eq(discountRedemptions.discountId, d.id), eq(discountRedemptions.customerId, ctx.customerId)),
          )) as [{ n: number }];
        if (n >= d.perCustomerLimit) return 'You have already used this code';
      }
      if (d.segmentId !== null) {
        const [seg] = await tx.select().from(segments).where(eq(segments.id, d.segmentId));
        const def = SegmentDefinition.parse(seg?.definition ?? {});
        const [hit] = await tx
          .select({ id: customers.id })
          .from(customers)
          .where(and(eq(customers.id, ctx.customerId), segmentWhere(ctx.tenantId, def, ctx.now)));
        if (!seg || !hit) return 'This code is not available for your account';
      }
    }
    return null;
  }

  async evaluate(
    tx: Tx,
    ctx: PromotionContext,
    currency: string,
    lineBasesMinor: string[],
  ): Promise<Evaluated> {
    const base = lineBasesMinor.reduce((a, b) => a + BigInt(b), 0n);
    const auto = tx
      .select()
      .from(discounts)
      .where(
        and(eq(discounts.tenantId, ctx.tenantId), isNull(discounts.code), eq(discounts.status, 'active')),
      )
      .orderBy(asc(discounts.id));
    const autos = ctx.lock ? await auto.for('update') : await auto;
    let codeRow: DiscountRow | undefined;
    let codeProblem: string | null = null;
    if (ctx.code) {
      const q = tx
        .select()
        .from(discounts)
        .where(and(eq(discounts.tenantId, ctx.tenantId), eq(discounts.code, ctx.code)));
      [codeRow] = ctx.lock ? await q.for('update') : await q;
      if (!codeRow) codeProblem = 'This code does not exist';
      else codeProblem = await this.why(tx, codeRow, ctx, currency, base);
    }
    const eligible: DiscountRow[] = [];
    for (const d of autos) if (!(await this.why(tx, d, ctx, currency, base))) eligible.push(d);
    if (codeRow && !codeProblem) eligible.push(codeRow);
    const mu = currencyMinorUnits(currency);
    const toInput = (d: DiscountRow) => ({
      id: d.id,
      label: label(d),
      mode: d.mode,
      value: d.value,
      code: d.code,
      discountId: d.id,
    });
    let chosen = eligible;
    if (eligible.length > 1 && !eligible.every((d) => d.combinable)) {
      const amount = (d: DiscountRow) =>
        BigInt(planPromotions(lineBasesMinor, [toInput(d)], mu).totals[0]!.discountMinor);
      const best = [...eligible].sort((a, b) =>
        amount(b) > amount(a) ? 1 : amount(b) < amount(a) ? -1 : 0,
      )[0]!;
      chosen = [best];
      if (codeRow && best.id !== codeRow.id)
        codeProblem = 'A better offer already applies and this code cannot be combined with it';
    }
    return { promotions: chosen.map(toInput), codeProblem };
  }

  /** Public summary for a quote. */
  static summarize(
    ev: Evaluated,
    totals: { id: string; discountMinor: string }[],
    code: string | null,
  ): AppliedPromotions {
    return {
      applied: ev.promotions.map((p) => ({
        discountId: p.discountId,
        code: p.code,
        label: p.label,
        discountMinor: totals.find((t) => t.id === p.id)?.discountMinor ?? '0',
      })),
      code,
      codeProblem: ev.codeProblem,
    };
  }

  /** Records redemptions for a placed order and bumps usage (rows were locked by `evaluate({ lock: true })`). */
  async redeem(
    tx: Tx,
    input: {
      tenantId: string;
      orderId: string;
      customerId: string | null;
      applied: AppliedPromotions['applied'];
    },
  ): Promise<void> {
    for (const a of input.applied) {
      if (a.discountMinor === '0') continue;
      await tx.insert(discountRedemptions).values({
        tenantId: input.tenantId,
        discountId: a.discountId,
        orderId: input.orderId,
        customerId: input.customerId,
        code: a.code,
        amountMinor: BigInt(a.discountMinor),
      });
      await tx
        .update(discounts)
        .set({ usedCount: sql`${discounts.usedCount} + 1` })
        .where(eq(discounts.id, a.discountId));
    }
  }
}
