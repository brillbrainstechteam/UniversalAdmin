import type { TenantPermission } from './permissions';

/** Platform phase whose modules are live in this build. Nav never shows modules from later phases. */
export const IMPLEMENTED_PHASE = 10;

export const FEATURES = {
  catalog: { label: 'Catalog', description: 'Products, variants, categories, collections' },
  jewellery: { label: 'Jewellery extension', description: 'Metal, purity, gross/net/fine/stone weights, HUID' },
  serialized_items: { label: 'Serialized items', description: 'Unique physical articles with actual attributes' },
  inventory: { label: 'Inventory', description: 'Stock ledger, balances, reservations' },
  metal_rates: { label: 'Metal rates', description: 'Rate sources, approval and history' },
  pricing: { label: 'Pricing', description: 'Price books, rules and quotes' },
  b2b_companies: { label: 'B2B companies', description: 'Companies, branches, buyers, credit' },
  rfq_quotes: { label: 'RFQ & quotations', description: 'Requests for quote and negotiation' },
  b2b_storefront: { label: 'B2B storefront', description: 'Buyer portal channel' },
  b2c_storefront: { label: 'B2C storefront', description: 'Retail storefront channel' },
  customers: { label: 'Customers', description: 'Consumer accounts and consent' },
  orders: { label: 'Orders', description: 'Carts, checkout, orders' },
  payments: { label: 'Payments', description: 'Payment adapters (sandbox until configured)' },
  fulfillment: { label: 'Fulfillment', description: 'Shipments, returns' },
  marketing: { label: 'Marketing', description: 'Campaigns, segments, consent' },
  discounts: { label: 'Discounts', description: 'Promotions and codes' },
  analytics: { label: 'Analytics', description: 'Reports with metric definitions' },
  online_store: { label: 'Online store', description: 'Themes, pages, menus, domains' },
  integrations: { label: 'Integrations', description: 'ERP connectors, imports, reconciliation' },
  automations: { label: 'Automations', description: 'Typed triggers, conditions, actions' },
} as const;
export type FeatureKey = keyof typeof FEATURES;
export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];

export const PRESETS = {
  b2b_jewellery: {
    label: 'B2B jewellery (wholesale)',
    features: [
      'catalog', 'jewellery', 'serialized_items', 'inventory', 'metal_rates', 'pricing', 'b2b_companies',
      'rfq_quotes', 'b2b_storefront', 'orders', 'payments', 'fulfillment', 'analytics', 'online_store',
      'integrations', 'automations',
    ],
  },
  b2c_jewellery: {
    label: 'B2C jewellery (retail)',
    features: [
      'catalog', 'jewellery', 'serialized_items', 'inventory', 'metal_rates', 'pricing', 'b2c_storefront',
      'customers', 'orders', 'payments', 'fulfillment', 'marketing', 'discounts', 'analytics', 'online_store',
      'integrations', 'automations',
    ],
  },
  hybrid_jewellery: {
    label: 'Hybrid jewellery (B2B + B2C)',
    features: FEATURE_KEYS,
  },
  general_commerce: {
    label: 'General commerce',
    features: [
      'catalog', 'inventory', 'pricing', 'b2c_storefront', 'customers', 'orders', 'payments', 'fulfillment',
      'marketing', 'discounts', 'analytics', 'online_store', 'integrations', 'automations',
    ],
  },
} as const satisfies Record<string, { label: string; features: readonly FeatureKey[] }>;
export type PresetKey = keyof typeof PRESETS;
export const PRESET_KEYS = Object.keys(PRESETS) as PresetKey[];

export type FeatureOverrides = Partial<Record<FeatureKey, boolean>>;

/** Effective entitlements = preset defaults with explicit per-tenant overrides applied (ADR-006). */
export function effectiveFeatures(preset: PresetKey, overrides: FeatureOverrides = {}): FeatureKey[] {
  const defaults = new Set<FeatureKey>(PRESETS[preset].features);
  return FEATURE_KEYS.filter((key) => overrides[key] ?? defaults.has(key));
}

/** Channel types and the feature that must be entitled to create them. */
export const CHANNEL_TYPES = {
  b2b_storefront: { label: 'B2B storefront', feature: 'b2b_storefront' },
  b2c_storefront: { label: 'B2C storefront', feature: 'b2c_storefront' },
  pos: { label: 'Point of sale / exhibition', feature: 'orders' },
  marketplace: { label: 'Marketplace', feature: 'integrations' },
  api: { label: 'Headless API', feature: 'catalog' },
} as const satisfies Record<string, { label: string; feature: FeatureKey }>;
export type ChannelType = keyof typeof CHANNEL_TYPES;

/** Default channels created at provisioning per preset. */
export const PRESET_DEFAULT_CHANNELS: Record<PresetKey, { code: string; name: string; type: ChannelType }[]> = {
  b2b_jewellery: [{ code: 'b2b-web', name: 'Wholesale portal', type: 'b2b_storefront' }],
  b2c_jewellery: [{ code: 'b2c-web', name: 'Online store', type: 'b2c_storefront' }],
  hybrid_jewellery: [
    { code: 'b2b-web', name: 'Wholesale portal', type: 'b2b_storefront' },
    { code: 'b2c-web', name: 'Online store', type: 'b2c_storefront' },
  ],
  general_commerce: [{ code: 'web', name: 'Online store', type: 'b2c_storefront' }],
};

export interface NavDefinition {
  key: string;
  label: string;
  /** Path relative to `/t/{tenantId}`. */
  path: string;
  section: 'main' | 'settings';
  /** At least one of these permissions is required. */
  anyPermission: TenantPermission[];
  /** Feature that must be entitled (if any). */
  feature?: FeatureKey;
  phase: number;
}

/** Merchant admin module registry in spec order (specs/00 UX principles). */
export const NAV_REGISTRY: NavDefinition[] = [
  { key: 'home', label: 'Home', path: '', section: 'main', anyPermission: [], phase: 1 },
  { key: 'orders', label: 'Orders', path: '/orders', section: 'main', anyPermission: ['orders.read'], feature: 'orders', phase: 7 },
  { key: 'products', label: 'Products', path: '/products', section: 'main', anyPermission: ['catalog.read'], feature: 'catalog', phase: 2 },
  { key: 'collections', label: 'Collections', path: '/collections', section: 'main', anyPermission: ['catalog.read'], feature: 'catalog', phase: 2 },
  { key: 'categories', label: 'Categories', path: '/categories', section: 'main', anyPermission: ['catalog.read'], feature: 'catalog', phase: 2 },
  { key: 'serial-items', label: 'Serialized items', path: '/serial-items', section: 'main', anyPermission: ['catalog.read'], feature: 'serialized_items', phase: 3 },
  { key: 'inventory', label: 'Inventory', path: '/inventory', section: 'main', anyPermission: ['inventory.read'], feature: 'inventory', phase: 4 },
  { key: 'companies', label: 'Companies', path: '/companies', section: 'main', anyPermission: ['companies.read'], feature: 'b2b_companies', phase: 8 },
  { key: 'customers', label: 'Customers', path: '/customers', section: 'main', anyPermission: ['customers.read'], feature: 'customers', phase: 9 },
  { key: 'rates', label: 'Pricing & Metal Rates', path: '/pricing', section: 'main', anyPermission: ['rates.read', 'pricing.read'], feature: 'pricing', phase: 6 },
  { key: 'marketing', label: 'Marketing', path: '/marketing', section: 'main', anyPermission: ['marketing.manage'], feature: 'marketing', phase: 10 },
  { key: 'discounts', label: 'Discounts', path: '/discounts', section: 'main', anyPermission: ['discounts.manage'], feature: 'discounts', phase: 10 },
  { key: 'analytics', label: 'Analytics', path: '/analytics', section: 'main', anyPermission: ['analytics.read'], feature: 'analytics', phase: 10 },
  { key: 'online-store', label: 'Online Store', path: '/online-store', section: 'main', anyPermission: ['content.manage'], feature: 'online_store', phase: 10 },
  { key: 'integrations', label: 'Integrations', path: '/integrations', section: 'main', anyPermission: ['integrations.read'], feature: 'integrations', phase: 5 },
  { key: 'automations', label: 'Automations', path: '/automations', section: 'main', anyPermission: ['integrations.manage'], feature: 'automations', phase: 11 },
  { key: 'audit', label: 'Audit log', path: '/audit', section: 'main', anyPermission: ['audit.read'], phase: 1 },
  { key: 'settings-general', label: 'General', path: '/settings/general', section: 'settings', anyPermission: ['settings.read'], phase: 1 },
  { key: 'settings-stores', label: 'Stores & channels', path: '/settings/stores', section: 'settings', anyPermission: ['stores.read'], phase: 1 },
  { key: 'settings-locations', label: 'Locations', path: '/settings/locations', section: 'settings', anyPermission: ['locations.read'], phase: 1 },
  { key: 'settings-attributes', label: 'Product attributes', path: '/settings/attributes', section: 'settings', anyPermission: ['catalog.read'], feature: 'catalog', phase: 2 },
  { key: 'settings-jewellery', label: 'Jewellery', path: '/settings/jewellery', section: 'settings', anyPermission: ['catalog.read'], feature: 'jewellery', phase: 3 },
  { key: 'settings-staff', label: 'Staff', path: '/settings/staff', section: 'settings', anyPermission: ['staff.read'], phase: 1 },
  { key: 'settings-roles', label: 'Roles', path: '/settings/roles', section: 'settings', anyPermission: ['roles.read'], phase: 1 },
];

export interface NavItem {
  key: string;
  label: string;
  path: string;
  section: 'main' | 'settings';
}

/** Navigation = implemented ∩ entitled ∩ permitted. Server computes it; UI renders it. */
export function computeNav(
  features: readonly FeatureKey[],
  permissions: readonly string[],
  implementedPhase: number = IMPLEMENTED_PHASE,
): NavItem[] {
  const featureSet = new Set(features);
  const permissionSet = new Set(permissions);
  return NAV_REGISTRY.filter(
    (item) =>
      item.phase <= implementedPhase &&
      (!item.feature || featureSet.has(item.feature)) &&
      (item.anyPermission.length === 0 || item.anyPermission.some((p) => permissionSet.has(p))),
  ).map(({ key, label, path, section }) => ({
    key,
    // Merchants without metal rates (general commerce) price from list prices only.
    label: key === 'rates' && !featureSet.has('metal_rates') ? 'Pricing' : label,
    path,
    section,
  }));
}
