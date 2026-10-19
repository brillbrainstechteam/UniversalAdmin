import { ratePerGram, RuleConditions, RuleDefinition, type RuleDefinitionInput } from '@uc/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from './client';
import { variants } from './catalog-schema';
import { purityDefinitions } from './jewellery-schema';
import {
  metalRates,
  priceBooks,
  priceListEntries,
  priceRules,
  priceRuleVersions,
  rateSources,
} from './pricing-schema';

export const DEMO_RATE_REASON = 'DEMO data: illustrative value, not a market rate';

/** Illustrative demo values only (INR per gram). Never shown as live market data. */
const DEMO_RATES: Record<string, string> = {
  '24K': '7250.00',
  '22K': '6650.00',
  '18K': '5440.00',
  '14K': '4230.00',
};

const GOLD_RULE: RuleDefinitionInput = {
  base: { kind: 'metal', weightBasis: 'item' },
  making: { mode: 'per_gram', amount: '450' },
  stones: {
    mode: 'per_carat',
    rates: [
      { kind: 'diamond', grade: null, amount: '60000' },
      { kind: 'gemstone', grade: null, amount: '5000' },
      { kind: 'pearl', grade: null, amount: '2000' },
    ],
  },
  charges: [{ code: 'hallmark', label: 'Hallmarking (DEMO amount)', mode: 'per_piece', amount: '45' }],
};

export interface DemoPricingInput {
  tenantId: string;
  currency: string;
  /** Approved demo metal rates + a gold rule (jewellery tenants). */
  metal: boolean;
  /** Proposer of the demo rates/rules (null = seed). Approver must differ (maker-checker). */
  makerId: string | null;
  checkerId: string;
  /** SKU → list price (major units) for a list-price rule. */
  listPrices?: Record<string, string>;
}

export async function seedDemoPricing(tx: Tx, input: DemoPricingInput): Promise<void> {
  const now = new Date();
  const [book] = await tx
    .insert(priceBooks)
    .values({
      tenantId: input.tenantId,
      name: 'Standard prices (DEMO)',
      currency: input.currency,
      createdBy: input.makerId,
    })
    .returning({ id: priceBooks.id });

  const rule = async (
    name: string,
    priority: number,
    conditions: unknown,
    definition: RuleDefinitionInput,
  ) => {
    const [r] = await tx
      .insert(priceRules)
      .values({ tenantId: input.tenantId, bookId: book!.id, name, createdBy: input.makerId })
      .returning({ id: priceRules.id });
    await tx.insert(priceRuleVersions).values({
      tenantId: input.tenantId,
      ruleId: r!.id,
      version: 1,
      status: 'published',
      priority,
      conditions: RuleConditions.parse(conditions),
      definition: RuleDefinition.parse(definition),
      notes: 'Demo rule — review every amount before use',
      createdBy: input.makerId,
      publishedBy: input.checkerId,
      publishedAt: now,
    });
  };

  if (input.metal) {
    const [manual] = await tx
      .select({ id: rateSources.id })
      .from(rateSources)
      .where(and(eq(rateSources.tenantId, input.tenantId), eq(rateSources.kind, 'manual')));
    const purities = await tx
      .select()
      .from(purityDefinitions)
      .where(
        and(
          eq(purityDefinitions.tenantId, input.tenantId),
          inArray(purityDefinitions.code, Object.keys(DEMO_RATES)),
        ),
      );
    for (const p of purities) {
      const value = DEMO_RATES[p.code]!;
      await tx.insert(metalRates).values({
        tenantId: input.tenantId,
        sourceId: manual!.id,
        metal: p.metal,
        purityId: p.id,
        currency: input.currency,
        ratePerG: ratePerGram(value, 'per_g'),
        inputValue: value,
        inputUnit: 'per_g',
        sourceAsOf: now,
        effectiveFrom: now,
        status: 'approved',
        reason: DEMO_RATE_REASON,
        proposedBy: input.makerId,
        proposedAt: now,
        decidedBy: input.checkerId,
        decidedAt: now,
        decisionNote: 'Demo approval',
      });
    }
    await rule(
      'Gold jewellery by billing weight (DEMO)',
      10,
      { productTypes: ['jewellery'], metals: ['gold'] },
      GOLD_RULE,
    );
  }

  if (input.listPrices) {
    const rows = await tx
      .select({ id: variants.id, sku: variants.sku })
      .from(variants)
      .where(
        and(eq(variants.tenantId, input.tenantId), inArray(variants.sku, Object.keys(input.listPrices))),
      );
    if (rows.length)
      await tx.insert(priceListEntries).values(
        rows.map((v) => ({
          tenantId: input.tenantId,
          bookId: book!.id,
          variantId: v.id,
          amount: input.listPrices![v.sku]!,
          updatedBy: input.makerId,
        })),
      );
    await rule('List prices (DEMO)', 0, { productTypes: ['standard'] }, { base: { kind: 'list_price' } });
  }
}
