import { RuleConditions, RuleDefinition } from '@uc/contracts';
import { eq } from 'drizzle-orm';
import type { Tx } from './client';
import { companies, companyBuyers, companyLocations } from './b2b-schema';
import { priceBooks, priceRules, priceRuleVersions } from './pricing-schema';

/**
 * Demo wholesale customer for Aurum (DEMO data): a company with two locations, a buyer with an order limit, a
 * company approver, a credit limit and its own contract price book. No GSTIN is seeded (format-only field).
 */
export async function seedDemoB2b(
  tx: Tx,
  input: {
    tenantId: string;
    buyerUserId: string;
    approverUserId: string;
    makerId: string;
    checkerId: string;
    repUserId: string | null;
  },
): Promise<void> {
  const now = new Date();
  const [book] = await tx
    .insert(priceBooks)
    .values({
      tenantId: input.tenantId,
      name: 'Shree contract prices (DEMO)',
      currency: 'INR',
      priority: 0,
      createdBy: input.makerId,
    })
    .returning({ id: priceBooks.id });
  const [rule] = await tx
    .insert(priceRules)
    .values({
      tenantId: input.tenantId,
      bookId: book!.id,
      name: 'Gold, contract making (DEMO)',
      createdBy: input.makerId,
    })
    .returning({ id: priceRules.id });
  await tx.insert(priceRuleVersions).values({
    tenantId: input.tenantId,
    ruleId: rule!.id,
    version: 1,
    status: 'published',
    priority: 10,
    conditions: RuleConditions.parse({ productTypes: ['jewellery'], metals: ['gold'] }),
    definition: RuleDefinition.parse({
      base: { kind: 'metal', weightBasis: 'item' },
      making: { mode: 'per_gram', amount: '350' },
      charges: [{ code: 'hallmark', label: 'Hallmarking (DEMO amount)', mode: 'per_piece', amount: '45' }],
    }),
    notes: 'Demo contract rule — review every amount before use',
    createdBy: input.makerId,
    publishedBy: input.checkerId,
    publishedAt: now,
  });
  const [company] = await tx
    .insert(companies)
    .values({
      tenantId: input.tenantId,
      name: 'Shree Jewels Pvt Ltd (DEMO)',
      code: 'SHREE',
      currency: 'INR',
      paymentTerms: 'on_account',
      creditLimitMinor: 50_000_000n, // ₹5,00,000.00
      minOrderMinor: 1_000_000n, // ₹10,000.00
      salesRepUserId: input.repUserId,
      priceBookId: book!.id,
      notes: 'Demo wholesale customer',
      createdBy: input.makerId,
    })
    .returning({ id: companies.id });
  const [mumbai] = await tx
    .insert(companyLocations)
    .values({
      tenantId: input.tenantId,
      companyId: company!.id,
      name: 'Mumbai head office',
      code: 'mumbai-ho',
      address: { line1: 'Kalbadevi Road (demo address)', city: 'Mumbai', countryCode: 'IN' },
    })
    .returning({ id: companyLocations.id });
  await tx.insert(companyLocations).values({
    tenantId: input.tenantId,
    companyId: company!.id,
    name: 'Pune store',
    code: 'pune-store',
    address: { line1: 'Laxmi Road (demo address)', city: 'Pune', countryCode: 'IN' },
  });
  await tx.insert(companyBuyers).values([
    {
      tenantId: input.tenantId,
      companyId: company!.id,
      userId: input.buyerUserId,
      email: 'buyer@shree.demo',
      role: 'buyer',
      locationIds: [mumbai!.id],
      orderLimitMinor: 10_000_000n, // ₹1,00,000.00 — above this the company approver decides
      status: 'active',
      acceptedAt: now,
      invitedBy: input.makerId,
    },
    {
      tenantId: input.tenantId,
      companyId: company!.id,
      userId: input.approverUserId,
      email: 'approver@shree.demo',
      role: 'approver',
      status: 'active',
      acceptedAt: now,
      invitedBy: input.makerId,
    },
  ]);
  await tx.update(companies).set({ updatedAt: now }).where(eq(companies.id, company!.id));
}
