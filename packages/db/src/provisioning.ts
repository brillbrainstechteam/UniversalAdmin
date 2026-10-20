import {
  DEFAULT_PURITIES,
  PRESET_DEFAULT_CHANNELS,
  SYSTEM_ROLES,
  type PresetKey,
  type ThemeTokens,
} from '@uc/contracts';
import { eq } from 'drizzle-orm';
import type { Tx } from './client';
import { stockSettings } from './inventory-schema';
import { orderSettings } from './orders-schema';
import { pricingSettings, rateSources } from './pricing-schema';
import { jewellerySettings, purityDefinitions } from './jewellery-schema';
import { channels, locations, roles, stores, tenants } from './schema';

export interface ProvisionTenantInput {
  slug: string;
  displayName: string;
  legalName: string;
  preset: PresetKey;
  countryCode: string;
  defaultCurrency: string;
  timezone: string;
  defaultLocale: string;
  contactEmail: string | null;
  isDemo: boolean;
  /** Phase 12: plan key (`plans.key`); defaults to `pilot`. */
  planKey?: string;
}

export type TenantRow = typeof tenants.$inferSelect;
export type RoleRow = typeof roles.$inferSelect;

export interface ProvisionedTenant {
  tenant: TenantRow;
  storeId: string;
  channelIds: string[];
  locationId: string;
  rolesByKey: Record<string, RoleRow>;
}

const PRESET_THEME: Record<PresetKey, Omit<ThemeTokens, 'brandName'>> = {
  b2b_jewellery: {
    primaryColor: '#1f3a5f',
    accentColor: '#c9a227',
    backgroundColor: '#ffffff',
    textColor: '#1b1b1f',
    fontFamily: 'sans',
    radius: 'sm',
    logoUrl: null,
  },
  b2c_jewellery: {
    primaryColor: '#5b1f3a',
    accentColor: '#d4af37',
    backgroundColor: '#fffdf8',
    textColor: '#1b1b1f',
    fontFamily: 'serif',
    radius: 'md',
    logoUrl: null,
  },
  hybrid_jewellery: {
    primaryColor: '#2d2a4a',
    accentColor: '#c9a227',
    backgroundColor: '#ffffff',
    textColor: '#1b1b1f',
    fontFamily: 'sans',
    radius: 'md',
    logoUrl: null,
  },
  general_commerce: {
    primaryColor: '#0b6e4f',
    accentColor: '#f2a541',
    backgroundColor: '#ffffff',
    textColor: '#1b1b1f',
    fontFamily: 'system',
    radius: 'md',
    logoUrl: null,
  },
};

export function defaultTheme(preset: PresetKey, brandName: string): ThemeTokens {
  return { brandName, ...PRESET_THEME[preset] };
}

/**
 * Creates a tenant with its default store, preset channels, main location and system roles.
 * Caller supplies a system (RLS-bypass) transaction and is responsible for audit/outbox/invitations.
 */
export async function provisionTenantRecords(
  tx: Tx,
  input: ProvisionTenantInput,
): Promise<ProvisionedTenant> {
  const [tenant] = await tx
    .insert(tenants)
    .values({ ...input, status: 'provisioning' })
    .returning();
  if (!tenant) throw new Error('tenant insert failed');

  const [store] = await tx
    .insert(stores)
    .values({
      tenantId: tenant.id,
      code: 'main',
      name: `${input.displayName} main store`,
      defaultCurrency: input.defaultCurrency,
      timezone: input.timezone,
    })
    .returning({ id: stores.id });
  if (!store) throw new Error('store insert failed');

  const channelIds: string[] = [];
  for (const def of PRESET_DEFAULT_CHANNELS[input.preset]) {
    const [channel] = await tx
      .insert(channels)
      .values({
        tenantId: tenant.id,
        storeId: store.id,
        code: def.code,
        name: def.name,
        type: def.type,
        theme: defaultTheme(input.preset, input.displayName),
      })
      .returning({ id: channels.id });
    if (channel) channelIds.push(channel.id);
  }

  const [location] = await tx
    .insert(locations)
    .values({
      tenantId: tenant.id,
      storeId: store.id,
      code: 'main-wh',
      name: 'Main warehouse',
      type: 'warehouse',
    })
    .returning({ id: locations.id });
  if (!location) throw new Error('location insert failed');

  const roleRows = await tx
    .insert(roles)
    .values(
      Object.entries(SYSTEM_ROLES).map(([key, def]) => ({
        tenantId: tenant.id,
        key,
        name: def.name,
        description: def.description,
        isSystem: true,
        permissions: [...def.permissions],
      })),
    )
    .returning();

  // Jewellery reference data (harmless for general tenants; features gate its use). Platform defaults must be
  // confirmed by the merchant before computed fine weights are relied on.
  await tx.insert(jewellerySettings).values({ tenantId: tenant.id });
  await tx.insert(stockSettings).values({ tenantId: tenant.id });
  await tx.insert(pricingSettings).values({ tenantId: tenant.id });
  await tx.insert(orderSettings).values({ tenantId: tenant.id });
  await tx.insert(rateSources).values({ tenantId: tenant.id, name: 'Manual entry', kind: 'manual' });
  await tx
    .insert(purityDefinitions)
    .values(
      DEFAULT_PURITIES.map((p) => ({ tenantId: tenant.id, ...p, source: 'platform_default' as const })),
    );

  const [active] = await tx
    .update(tenants)
    .set({ status: 'active' })
    .where(eq(tenants.id, tenant.id))
    .returning();

  return {
    tenant: active ?? tenant,
    storeId: store.id,
    channelIds,
    locationId: location.id,
    rolesByKey: Object.fromEntries(roleRows.map((r) => [r.key, r])),
  };
}
