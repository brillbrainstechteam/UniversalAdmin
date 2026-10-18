import { optionKey } from '@uc/contracts';
import type { Tx } from './client';
import { categories, channelPublications, products, variants } from './catalog-schema';

interface DemoProduct {
  title: string;
  slug: string;
  productType: 'standard' | 'jewellery';
  brand: string;
  category: string;
  options: { name: string; values: string[] }[];
  variants: { sku: string; optionValues: Record<string, string> }[];
}

/**
 * Small demo catalog (no prices or stock — Phases 04/06). Descriptions say "Demo product" so it is never
 * mistaken for real merchandise. Products are active and published to the tenant's first channel.
 */
export async function seedDemoCatalog(
  tx: Tx,
  tenantId: string,
  channelId: string,
  categoryNames: string[],
  items: DemoProduct[],
): Promise<void> {
  const categoryIds = new Map<string, string>();
  for (const [position, name] of categoryNames.entries()) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const [c] = await tx
      .insert(categories)
      .values({ tenantId, name, slug, position })
      .returning({ id: categories.id });
    categoryIds.set(name, c!.id);
  }
  for (const item of items) {
    const [p] = await tx
      .insert(products)
      .values({
        tenantId,
        title: item.title,
        slug: item.slug,
        status: 'active',
        productType: item.productType,
        brand: item.brand,
        categoryId: categoryIds.get(item.category) ?? null,
        description:
          'Demo product for evaluation. Not real merchandise; prices and stock arrive in later phases.',
        options: item.options,
      })
      .returning({ id: products.id });
    await tx.insert(variants).values(
      item.variants.map((v, position) => ({
        tenantId,
        productId: p!.id,
        sku: v.sku,
        title: Object.values(v.optionValues).join(' / '),
        optionValues: v.optionValues,
        optionKey: optionKey(v.optionValues),
        position,
      })),
    );
    await tx
      .insert(channelPublications)
      .values({ tenantId, productId: p!.id, channelId, status: 'published', publishedAt: new Date() });
  }
}

const sizes = (prefix: string, values: string[], name = 'Size') =>
  values.map((v) => ({ sku: `${prefix}-${v}`.toUpperCase(), optionValues: { [name]: v } }));

export const DEMO_CATALOG = {
  aurum: {
    categories: ['Rings', 'Chains', 'Bangles'],
    items: [
      {
        title: '22K Plain Gold Band',
        slug: '22k-plain-gold-band',
        productType: 'jewellery',
        brand: 'Aurum',
        category: 'Rings',
        options: [{ name: 'Size', values: ['12', '14', '16'] }],
        variants: sizes('AUR-BAND22', ['12', '14', '16']),
      },
      {
        title: '18K Rope Chain',
        slug: '18k-rope-chain',
        productType: 'jewellery',
        brand: 'Aurum',
        category: 'Chains',
        options: [{ name: 'Length', values: ['18in', '20in'] }],
        variants: sizes('AUR-ROPE18', ['18in', '20in'], 'Length'),
      },
      {
        title: 'Antique Kada Bangle',
        slug: 'antique-kada-bangle',
        productType: 'jewellery',
        brand: 'Aurum',
        category: 'Bangles',
        options: [],
        variants: [{ sku: 'AUR-KADA-01', optionValues: {} }],
      },
    ],
  },
  lumiere: {
    categories: ['Engagement', 'Earrings'],
    items: [
      {
        title: 'Solitaire Diamond Ring',
        slug: 'solitaire-diamond-ring',
        productType: 'jewellery',
        brand: 'Lumière',
        category: 'Engagement',
        options: [{ name: 'Size', values: ['5', '6', '7'] }],
        variants: sizes('LUM-SOL', ['5', '6', '7']),
      },
      {
        title: 'Pearl Drop Earrings',
        slug: 'pearl-drop-earrings',
        productType: 'jewellery',
        brand: 'Lumière',
        category: 'Earrings',
        options: [],
        variants: [{ sku: 'LUM-PEARL-01', optionValues: {} }],
      },
    ],
  },
  northwind: {
    categories: ['Bags', 'Kitchen'],
    items: [
      {
        title: 'Canvas Tote',
        slug: 'canvas-tote',
        productType: 'standard',
        brand: 'Northwind',
        category: 'Bags',
        options: [{ name: 'Colour', values: ['Natural', 'Navy'] }],
        variants: sizes('NW-TOTE', ['Natural', 'Navy'], 'Colour'),
      },
      {
        title: 'Enamel Mug',
        slug: 'enamel-mug',
        productType: 'standard',
        brand: 'Northwind',
        category: 'Kitchen',
        options: [],
        variants: [{ sku: 'NW-MUG-01', optionValues: {} }],
      },
    ],
  },
} satisfies Record<string, { categories: string[]; items: DemoProduct[] }>;
