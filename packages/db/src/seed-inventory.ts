import { and, eq, inArray } from 'drizzle-orm';
import { variants } from './catalog-schema';
import type { Tx } from './client';
import { postMovements, setSerialState } from './inventory';
import { variantStockSettings } from './inventory-schema';
import { serialItems } from './jewellery-schema';

export interface DemoReceipt {
  location: string;
  /** Clearly labelled demo document number. */
  reference: string;
  lines: { sku: string; quantity: string }[];
  pieces?: string[];
}

/**
 * Demo opening stock, posted through the real ledger engine (so balances always equal the ledger). Pieces are
 * serial-tracked; everything else is counted in pcs. All references and notes are labelled DEMO.
 */
export async function seedDemoInventory(
  tx: Tx,
  tenantId: string,
  locationByKey: Record<string, string>,
  receipts: DemoReceipt[],
): Promise<void> {
  const skus = receipts.flatMap((r) => r.lines.map((l) => l.sku));
  const tags = receipts.flatMap((r) => r.pieces ?? []);
  const vs = skus.length
    ? await tx
        .select({ id: variants.id, sku: variants.sku })
        .from(variants)
        .where(and(eq(variants.tenantId, tenantId), inArray(variants.sku, skus)))
    : [];
  const pieces = tags.length
    ? await tx
        .select()
        .from(serialItems)
        .where(and(eq(serialItems.tenantId, tenantId), inArray(serialItems.serialTag, tags)))
    : [];
  const serialVariants = [...new Set(pieces.map((p) => p.variantId))];
  if (serialVariants.length) {
    await tx
      .insert(variantStockSettings)
      .values(
        serialVariants.map((variantId) => ({
          tenantId,
          variantId,
          tracking: 'serial' as const,
          unit: 'pcs' as const,
          version: 1,
        })),
      )
      .onConflictDoNothing();
  }
  for (const r of receipts) {
    const locationId = locationByKey[r.location];
    if (!locationId) throw new Error(`demo location ${r.location} missing`);
    const own = pieces.filter((p) => (r.pieces ?? []).includes(p.serialTag));
    await postMovements(tx, {
      tenantId,
      type: 'receipt',
      reference: r.reference,
      note: 'DEMO opening stock (seed data, not real inventory)',
      actorUserId: null,
      lines: [
        ...r.lines.map((l) => {
          const v = vs.find((x) => x.sku === l.sku);
          if (!v) throw new Error(`demo sku ${l.sku} missing`);
          return { variantId: v.id, locationId, condition: 'sellable' as const, onHand: l.quantity };
        }),
        ...own.map((p) => ({
          variantId: p.variantId,
          locationId,
          condition: 'sellable' as const,
          onHand: '1',
          serialItemId: p.id,
        })),
      ],
    });
    await setSerialState(
      tx,
      tenantId,
      own.map((p) => p.id),
      ['not_received'],
      'in_stock',
      locationId,
    );
  }
}

export const DEMO_INVENTORY: Record<'aurum' | 'lumiere' | 'northwind', DemoReceipt[]> = {
  aurum: [
    {
      location: 'main',
      reference: 'DEMO-GRN-0001',
      lines: [
        { sku: 'AUR-BAND22-12', quantity: '10' },
        { sku: 'AUR-BAND22-16', quantity: '6' },
        { sku: 'AUR-ROPE18-18IN', quantity: '4' },
        { sku: 'AUR-ROPE18-20IN', quantity: '1' },
      ],
      pieces: ['AUR-T-0001', 'AUR-T-0002'],
    },
    {
      location: 'mumbai',
      reference: 'DEMO-GRN-0002',
      lines: [{ sku: 'AUR-KADA-01', quantity: '2' }],
      pieces: ['AUR-T-0003'],
    },
  ],
  lumiere: [
    {
      location: 'main',
      reference: 'DEMO-GRN-0001',
      lines: [
        { sku: 'LUM-SOL-5', quantity: '3' },
        { sku: 'LUM-SOL-7', quantity: '1' },
        { sku: 'LUM-PEARL-01', quantity: '2' },
      ],
      pieces: ['LUM-T-0001'],
    },
  ],
  northwind: [
    {
      location: 'main',
      reference: 'DEMO-GRN-0001',
      lines: [
        { sku: 'NW-TOTE-NATURAL', quantity: '25' },
        { sku: 'NW-MUG-01', quantity: '40' },
      ],
    },
  ],
};
