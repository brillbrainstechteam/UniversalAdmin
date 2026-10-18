import { computeFine, toGrams } from '@uc/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { products, variants } from './catalog-schema';
import type { Tx } from './client';
import { jewellerySpecs, purityDefinitions, serialItems } from './jewellery-schema';

/**
 * Demo jewellery measurements. Weights are illustrative; HUIDs use an obviously fake "DEMO" prefix.
 * Purities are the platform defaults seeded at provisioning (unconfirmed, shown as such in the admin).
 */
export async function seedDemoJewellery(
  tx: Tx,
  tenantId: string,
  plan: { sku: string; purity: string; gross: string; net: string; stone?: string }[],
  items: { sku: string; tag: string; huid: string; gross: string; net: string }[],
) {
  const purities = await tx.select().from(purityDefinitions).where(eq(purityDefinitions.tenantId, tenantId));
  const purityByCode = new Map(purities.map((p) => [p.code, p]));
  const skus = [...new Set([...plan.map((p) => p.sku), ...items.map((i) => i.sku)])];
  const vs = await tx
    .select({ id: variants.id, sku: variants.sku })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(
      and(
        eq(variants.tenantId, tenantId),
        inArray(variants.sku, skus),
        eq(products.productType, 'jewellery'),
      ),
    );
  const variantBySku = new Map(vs.map((v) => [v.sku, v.id]));
  const specPurity = new Map<string, (typeof purities)[number]>();
  for (const p of plan) {
    const purity = purityByCode.get(p.purity)!;
    const net = toGrams(p.net, 'g');
    const fine = computeFine({ netG: net, fineness: purity.fineness }, 3);
    await tx.insert(jewellerySpecs).values({
      tenantId,
      variantId: variantBySku.get(p.sku)!,
      metal: purity.metal,
      purityId: purity.id,
      grossG: toGrams(p.gross, 'g'),
      netG: net,
      stoneG: toGrams(p.stone ?? '0', 'g'),
      fineG: fine.fineG,
      fineSource: 'computed',
      billingBasis: 'net',
      raw: {
        gross: { value: p.gross, unit: 'g' },
        net: { value: p.net, unit: 'g' },
        source: 'demo_seed',
        fineFormula: fine.formula,
      },
    });
    specPurity.set(p.sku, purity);
  }
  for (const i of items) {
    const purity = specPurity.get(i.sku)!;
    const net = toGrams(i.net, 'g');
    const fine = computeFine({ netG: net, fineness: purity.fineness }, 3);
    await tx.insert(serialItems).values({
      tenantId,
      variantId: variantBySku.get(i.sku)!,
      serialTag: i.tag,
      huid: i.huid,
      metal: purity.metal,
      purityId: purity.id,
      grossG: toGrams(i.gross, 'g'),
      netG: net,
      stoneG: '0',
      fineG: fine.fineG,
      fineSource: 'computed',
      fineFormula: fine.formula,
      raw: { gross: { value: i.gross, unit: 'g' }, net: { value: i.net, unit: 'g' }, source: 'demo_seed' },
    });
  }
}

export const DEMO_JEWELLERY = {
  aurum: {
    specs: [
      { sku: 'AUR-BAND22-12', purity: '22K', gross: '4.200', net: '4.200' },
      { sku: 'AUR-BAND22-14', purity: '22K', gross: '4.600', net: '4.600' },
      { sku: 'AUR-BAND22-16', purity: '22K', gross: '5.000', net: '5.000' },
      { sku: 'AUR-ROPE18-18IN', purity: '18K', gross: '9.800', net: '9.800' },
      { sku: 'AUR-ROPE18-20IN', purity: '18K', gross: '10.900', net: '10.900' },
      { sku: 'AUR-KADA-01', purity: '22K', gross: '24.500', net: '23.900', stone: '0.600' },
    ],
    // Three pieces of the same design, each with its own actual weight and HUID.
    items: [
      { sku: 'AUR-BAND22-14', tag: 'AUR-T-0001', huid: 'DEMO01', gross: '4.612', net: '4.612' },
      { sku: 'AUR-BAND22-14', tag: 'AUR-T-0002', huid: 'DEMO02', gross: '4.587', net: '4.587' },
      { sku: 'AUR-BAND22-14', tag: 'AUR-T-0003', huid: 'DEMO03', gross: '4.634', net: '4.634' },
    ],
  },
  lumiere: {
    specs: [
      { sku: 'LUM-SOL-5', purity: '18K', gross: '3.100', net: '2.900', stone: '0.200' },
      { sku: 'LUM-SOL-6', purity: '18K', gross: '3.250', net: '3.050', stone: '0.200' },
      { sku: 'LUM-SOL-7', purity: '18K', gross: '3.400', net: '3.200', stone: '0.200' },
      { sku: 'LUM-PEARL-01', purity: '14K', gross: '5.300', net: '1.800', stone: '3.500' },
    ],
    items: [{ sku: 'LUM-SOL-6', tag: 'LUM-T-0001', huid: 'DEMO11', gross: '3.262', net: '3.061' }],
  },
};
