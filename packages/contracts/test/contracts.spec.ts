import { describe, expect, it } from 'vitest';
import {
  ALL_TENANT_PERMISSIONS,
  API_ROUTES,
  buildOpenApiDocument,
  computeNav,
  CreateTenantRequest,
  effectiveFeatures,
  NAV_REGISTRY,
  PRESETS,
  SYSTEM_ROLES,
  ThemeTokens,
  UpdateTenantSettingsRequest,
  Code,
  DecimalString,
} from '../src';

describe('feature presets (ADR-006)', () => {
  it('general commerce has no jewellery-specific features (F-12)', () => {
    const features = effectiveFeatures('general_commerce');
    expect(features).not.toContain('jewellery');
    expect(features).not.toContain('metal_rates');
    expect(features).not.toContain('serialized_items');
    expect(features).toContain('catalog');
  });

  it('B2B and B2C jewellery presets differ in channel features', () => {
    expect(effectiveFeatures('b2b_jewellery')).toContain('b2b_storefront');
    expect(effectiveFeatures('b2b_jewellery')).not.toContain('b2c_storefront');
    expect(effectiveFeatures('b2c_jewellery')).toContain('b2c_storefront');
    expect(effectiveFeatures('hybrid_jewellery')).toEqual(expect.arrayContaining(['b2b_storefront', 'b2c_storefront']));
  });

  it('explicit overrides win over preset defaults in both directions', () => {
    const f = effectiveFeatures('general_commerce', { jewellery: true, marketing: false });
    expect(f).toContain('jewellery');
    expect(f).not.toContain('marketing');
  });

  it('every preset only references known features', () => {
    for (const preset of Object.values(PRESETS)) expect(preset.features.length).toBeGreaterThan(0);
  });
});

describe('navigation gating (implemented ∩ entitled ∩ permitted)', () => {
  it('hides modules from later phases even when entitled and permitted', () => {
    const nav = computeNav(effectiveFeatures('hybrid_jewellery'), ALL_TENANT_PERMISSIONS, 1);
    const keys = nav.map((n) => n.key);
    expect(keys).toContain('home');
    expect(keys).toContain('settings-staff');
    expect(keys).not.toContain('products'); // phase 2
    expect(keys).not.toContain('orders'); // phase 7
  });

  it('requires permissions for gated entries', () => {
    const keys = computeNav(effectiveFeatures('b2b_jewellery'), ['locations.read'], 1).map((n) => n.key);
    expect(keys).toEqual(['home', 'settings-locations']);
  });

  it('requires entitlement once a module is implemented', () => {
    const general = computeNav(effectiveFeatures('general_commerce'), ALL_TENANT_PERMISSIONS, 12).map((n) => n.key);
    expect(general).not.toContain('companies'); // b2b_companies not in general preset
    const b2b = computeNav(effectiveFeatures('b2b_jewellery'), ALL_TENANT_PERMISSIONS, 12).map((n) => n.key);
    expect(b2b).toContain('companies');
    expect(b2b).not.toContain('customers');
  });

  it('nav registry keys are unique', () => {
    const keys = NAV_REGISTRY.map((n) => n.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('permission catalog and system roles', () => {
  it('system roles reference only catalog permissions', () => {
    for (const role of Object.values(SYSTEM_ROLES)) {
      for (const p of role.permissions) expect(ALL_TENANT_PERMISSIONS).toContain(p);
    }
  });
  it('maker-checker: rate editor cannot approve, approver cannot edit', () => {
    expect(SYSTEM_ROLES.rate_editor!.permissions).not.toContain('rates.approve');
    expect(SYSTEM_ROLES.rate_approver!.permissions).not.toContain('rates.edit');
  });
  it('viewer is read-only', () => {
    expect(SYSTEM_ROLES.viewer!.permissions.every((p) => p.endsWith('.read'))).toBe(true);
  });
});

describe('shared validation schemas', () => {
  it('codes are lower-case slugs', () => {
    expect(Code.safeParse('mumbai-branch').success).toBe(true);
    expect(Code.safeParse('Mumbai Branch').success).toBe(false);
    expect(Code.safeParse('a--b').success).toBe(false);
  });

  it('decimals are strings, never floats', () => {
    expect(DecimalString.safeParse('245.730000').success).toBe(true);
    expect(DecimalString.safeParse(245.73).success).toBe(false);
    expect(DecimalString.safeParse('1.1234567').success).toBe(false);
  });

  it('theme tokens require hex colours and https logos', () => {
    const base = { brandName: 'X', primaryColor: '#112233', accentColor: '#112233', backgroundColor: '#ffffff', textColor: '#000000', fontFamily: 'serif', radius: 'md', logoUrl: null };
    expect(ThemeTokens.safeParse(base).success).toBe(true);
    expect(ThemeTokens.safeParse({ ...base, primaryColor: 'red' }).success).toBe(false);
    expect(ThemeTokens.safeParse({ ...base, logoUrl: 'http://x.test/logo.png' }).success).toBe(false);
    expect(ThemeTokens.safeParse({ ...base, logoUrl: 'javascript:alert(1)' }).success).toBe(false);
  });

  it('tenant creation normalizes emails and validates region codes', () => {
    const ok = CreateTenantRequest.parse({
      slug: 'shree-jewels',
      displayName: 'Shree',
      legalName: 'Shree Pvt Ltd',
      preset: 'b2c_jewellery',
      countryCode: 'IN',
      defaultCurrency: 'INR',
      timezone: 'Asia/Kolkata',
      defaultLocale: 'en-IN',
      contactEmail: 'Hello@Shree.TEST',
      ownerEmail: 'Owner@Shree.test',
    });
    expect(ok.ownerEmail).toBe('owner@shree.test');
    expect(ok.isDemo).toBe(false);
    expect(CreateTenantRequest.safeParse({ ...ok, timezone: 'Mars/Base' }).success).toBe(false);
    expect(CreateTenantRequest.safeParse({ ...ok, defaultCurrency: 'inr' }).success).toBe(false);
  });

  it('PATCH bodies require an optimistic-lock version', () => {
    expect(UpdateTenantSettingsRequest.safeParse({ displayName: 'X Y' }).success).toBe(false);
    expect(UpdateTenantSettingsRequest.safeParse({ version: 0, displayName: 'X Y' }).success).toBe(true);
  });
});

describe('OpenAPI document', () => {
  const doc = buildOpenApiDocument();

  it('documents every registered route with an error schema', () => {
    for (const route of API_ROUTES) {
      const op = (doc.paths?.[route.path] as Record<string, { responses: Record<string, unknown> }> | undefined)?.[route.method];
      expect(op, `${route.method} ${route.path}`).toBeDefined();
      expect(Object.keys(op!.responses)).toContain('500');
    }
  });

  it('admin and platform routes declare their security scheme', () => {
    const stores = (doc.paths?.['/v1/admin/stores'] as Record<string, { security?: unknown[] }>).get;
    expect(stores?.security).toEqual([{ merchantSession: [], tenantHeader: [] }]);
    const tenants = (doc.paths?.['/v1/platform/tenants'] as Record<string, { security?: unknown[] }>).get;
    expect(tenants?.security).toEqual([{ platformSession: [] }]);
  });

  it('creation endpoints with side effects require Idempotency-Key', () => {
    const op = (doc.paths?.['/v1/platform/tenants'] as Record<string, { parameters?: { name: string; in: string; required?: boolean }[] }>).post;
    expect(op?.parameters?.some((p) => p.in === 'header' && p.name === 'idempotency-key' && p.required)).toBe(true);
  });
});
