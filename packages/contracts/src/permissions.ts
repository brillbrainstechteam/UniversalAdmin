/**
 * Code-defined permission catalog (ADR-005). Keys are stable API; never rename, only deprecate.
 * `phase` = phase in which an endpoint first enforces the permission. Roles may hold any key now.
 */
export const TENANT_PERMISSIONS = {
  'settings.read': { group: 'Settings', label: 'View business settings', phase: 1 },
  'settings.manage': { group: 'Settings', label: 'Edit business settings', phase: 1 },
  'stores.read': { group: 'Stores & channels', label: 'View stores and channels', phase: 1 },
  'stores.manage': { group: 'Stores & channels', label: 'Create and edit stores and channels', phase: 1 },
  'locations.read': { group: 'Locations', label: 'View locations', phase: 1 },
  'locations.manage': { group: 'Locations', label: 'Create and edit locations', phase: 1 },
  'staff.read': { group: 'Staff', label: 'View staff and invitations', phase: 1 },
  'staff.manage': { group: 'Staff', label: 'Invite, change roles, suspend staff', phase: 1 },
  'roles.read': { group: 'Staff', label: 'View roles', phase: 1 },
  'roles.manage': { group: 'Staff', label: 'Create and edit custom roles', phase: 1 },
  'audit.read': { group: 'Audit', label: 'View audit log', phase: 1 },
  'catalog.read': { group: 'Catalog', label: 'View products', phase: 2 },
  'catalog.edit': { group: 'Catalog', label: 'Edit products (non-ERP-owned fields)', phase: 2 },
  'catalog.publish': { group: 'Catalog', label: 'Publish products to channels', phase: 2 },
  'jewellery.edit': { group: 'Catalog', label: 'Edit jewellery measurements and serial items', phase: 3 },
  'jewellery.review': { group: 'Catalog', label: 'Review weight exceptions and correct HUIDs (maker-checker)', phase: 3 },
  'inventory.read': { group: 'Inventory', label: 'View stock', phase: 4 },
  'inventory.adjust': { group: 'Inventory', label: 'Adjust stock with reason', phase: 4 },
  'inventory.transfer': { group: 'Inventory', label: 'Transfer stock between locations', phase: 4 },
  'inventory.reserve': { group: 'Inventory', label: 'Hold, commit and release stock reservations', phase: 4 },
  'integrations.read': { group: 'Integrations', label: 'View connectors and sync jobs', phase: 5 },
  'integrations.manage': { group: 'Integrations', label: 'Configure connectors and mappings', phase: 5 },
  'reconciliation.resolve': { group: 'Integrations', label: 'Resolve reconciliation issues', phase: 5 },
  'rates.read': { group: 'Pricing & rates', label: 'View metal rates', phase: 6 },
  'rates.edit': { group: 'Pricing & rates', label: 'Draft metal rates', phase: 6 },
  'rates.approve': { group: 'Pricing & rates', label: 'Approve and publish metal rates', phase: 6 },
  'pricing.read': { group: 'Pricing & rates', label: 'View price books and rules', phase: 6 },
  'pricing.edit': { group: 'Pricing & rates', label: 'Draft price rules', phase: 6 },
  'pricing.publish': { group: 'Pricing & rates', label: 'Publish price rules', phase: 6 },
  'orders.read': { group: 'Orders', label: 'View orders and quotes', phase: 7 },
  'orders.manage': { group: 'Orders', label: 'Create and edit orders and quotes', phase: 7 },
  'orders.approve': { group: 'Orders', label: 'Approve orders', phase: 7 },
  'payments.read': { group: 'Payments', label: 'View payments', phase: 7 },
  'payments.refund': { group: 'Payments', label: 'Issue refunds', phase: 9 },
  'fulfillment.manage': { group: 'Fulfillment', label: 'Pick, pack and ship', phase: 9 },
  'companies.read': { group: 'Customers', label: 'View companies and buyers', phase: 8 },
  'companies.manage': { group: 'Customers', label: 'Manage companies, buyers and credit', phase: 8 },
  'customers.read': { group: 'Customers', label: 'View customers', phase: 9 },
  'customers.manage': { group: 'Customers', label: 'Manage customers', phase: 9 },
  'content.manage': { group: 'Online store', label: 'Manage pages, menus, themes', phase: 10 },
  'marketing.manage': { group: 'Marketing', label: 'Manage campaigns and segments', phase: 10 },
  'discounts.manage': { group: 'Marketing', label: 'Manage discounts', phase: 10 },
  'analytics.read': { group: 'Analytics', label: 'View reports', phase: 10 },
  'operations.read': { group: 'Operations', label: 'View operations health', phase: 11 },
  'webhooks.manage': { group: 'Operations', label: 'Manage outbound webhooks', phase: 11 },
  'apikeys.manage': { group: 'Operations', label: 'Create and revoke API keys', phase: 11 },
  'support.manage': { group: 'Settings', label: 'Approve, deny and revoke platform support access', phase: 12 },
} as const satisfies Record<string, { group: string; label: string; phase: number }>;

export type TenantPermission = keyof typeof TENANT_PERMISSIONS;
export const ALL_TENANT_PERMISSIONS = Object.keys(TENANT_PERMISSIONS) as TenantPermission[];

export function isTenantPermission(value: string): value is TenantPermission {
  return Object.prototype.hasOwnProperty.call(TENANT_PERMISSIONS, value);
}

// Customer personal data is not "non-sensitive": viewers do not get customers.read (Phase 09).
const readOnly = ALL_TENANT_PERMISSIONS.filter(
  (p) => p.endsWith('.read') && p !== 'audit.read' && p !== 'customers.read',
);

/** System role templates seeded into every tenant (read-only in the UI). */
export const SYSTEM_ROLES: Record<string, { name: string; description: string; permissions: TenantPermission[] }> =
  {
    owner: {
      name: 'Owner',
      description: 'Full access including ownership changes',
      permissions: ALL_TENANT_PERMISSIONS,
    },
    admin: {
      name: 'Administrator',
      description: 'Full access except ownership changes and approving platform support access',
      permissions: ALL_TENANT_PERMISSIONS.filter((p) => p !== 'support.manage'),
    },
    catalog_editor: {
      name: 'Catalog editor',
      description: 'Edits website content, not ERP-authoritative fields',
      permissions: ['catalog.read', 'catalog.edit', 'catalog.publish', 'stores.read', 'locations.read'],
    },
    inventory_operator: {
      name: 'Inventory operator',
      description: 'Validated stock adjustments within assigned locations',
      permissions: ['inventory.read', 'inventory.adjust', 'inventory.transfer', 'inventory.reserve', 'locations.read', 'catalog.read', 'jewellery.edit'],
    },
    rate_editor: {
      name: 'Rate editor',
      description: 'Drafts metal rates and price rules',
      permissions: ['rates.read', 'rates.edit', 'pricing.read', 'pricing.edit'],
    },
    rate_approver: {
      name: 'Rate approver',
      description: 'Approves and publishes rates and price rules (maker-checker)',
      permissions: ['rates.read', 'rates.approve', 'pricing.read', 'pricing.publish', 'audit.read'],
    },
    sales_rep: {
      name: 'Sales representative',
      description: 'Assigned companies, quotes and orders',
      permissions: ['companies.read', 'orders.read', 'orders.manage', 'catalog.read', 'pricing.read', 'inventory.read', 'inventory.reserve'],
    },
    accountant: {
      name: 'Accountant',
      description: 'Payment and invoice reconciliation',
      permissions: ['orders.read', 'payments.read', 'payments.refund', 'companies.read', 'audit.read'],
    },
    fulfillment_operator: {
      name: 'Fulfillment operator',
      description: 'Pick, pack and ship',
      permissions: ['orders.read', 'fulfillment.manage', 'inventory.read', 'locations.read'],
    },
    marketer: {
      name: 'Marketer',
      description: 'Campaigns, discounts and content',
      permissions: ['marketing.manage', 'discounts.manage', 'content.manage', 'analytics.read', 'customers.read'],
    },
    viewer: {
      name: 'Viewer',
      description: 'Read-only access to non-sensitive areas',
      permissions: readOnly,
    },
  };

export const PLATFORM_PERMISSIONS = {
  'platform.tenants.read': 'View tenants',
  'platform.tenants.manage': 'Provision, edit, suspend tenants',
  'platform.entitlements.manage': 'Change tenant feature entitlements',
  'platform.audit.read': 'View platform audit log',
  'platform.plans.manage': 'Create plans and assign them to tenants',
  'platform.support.request': 'Request just-in-time, merchant-approved support access',
} as const;
export type PlatformPermission = keyof typeof PLATFORM_PERMISSIONS;

export const PLATFORM_ROLES = {
  platform_owner: {
    name: 'Platform owner',
    permissions: Object.keys(PLATFORM_PERMISSIONS) as PlatformPermission[],
  },
  platform_support: {
    name: 'Platform support',
    permissions: ['platform.tenants.read', 'platform.audit.read', 'platform.support.request'] as PlatformPermission[],
  },
} as const;
export type PlatformRole = keyof typeof PLATFORM_ROLES;
export const PLATFORM_ROLE_KEYS = Object.keys(PLATFORM_ROLES) as PlatformRole[];
