import { eq } from 'drizzle-orm';
import type { Db, Tx } from './client';
import { systemTx } from './client';
import { writeAudit } from './audit';
import { hashPassword } from './crypto';
import { provisionTenantRecords, type ProvisionTenantInput } from './provisioning';
import {
  channelDomains,
  channels,
  locations,
  membershipRoles,
  memberships,
  platformAdmins,
  tenants,
  users,
} from './schema';

/**
 * Demo data (all tenants flagged is_demo). Two isolated jewellery merchants + one general-commerce tenant.
 * Domains use *.localhost so they resolve to 127.0.0.1 in browsers without DNS changes.
 */
export const DEMO = {
  platform: { owner: 'platform@uc.local', support: 'support@uc.local' },
  tenants: {
    aurum: {
      slug: 'aurum-wholesale',
      displayName: 'Aurum Wholesale Jewellers (DEMO)',
      legalName: 'Aurum Wholesale Jewellers Pvt Ltd (demo data)',
      preset: 'b2b_jewellery',
      countryCode: 'IN',
      defaultCurrency: 'INR',
      timezone: 'Asia/Kolkata',
      defaultLocale: 'en-IN',
      contactEmail: 'contact@aurum.demo',
      isDemo: true,
      domain: 'aurum-b2b.localhost',
      pendingDomain: 'pending-aurum.localhost',
    },
    lumiere: {
      slug: 'lumiere-fine',
      displayName: 'Lumière Fine Jewellery (DEMO)',
      legalName: 'Lumière Fine Jewellery LLP (demo data)',
      preset: 'b2c_jewellery',
      countryCode: 'IN',
      defaultCurrency: 'INR',
      timezone: 'Asia/Kolkata',
      defaultLocale: 'en-IN',
      contactEmail: 'hello@lumiere.demo',
      isDemo: true,
      domain: 'lumiere.localhost',
    },
    northwind: {
      slug: 'northwind-general',
      displayName: 'Northwind General Store (DEMO)',
      legalName: 'Northwind General Store Ltd (demo data)',
      preset: 'general_commerce',
      countryCode: 'GB',
      defaultCurrency: 'GBP',
      timezone: 'Europe/London',
      defaultLocale: 'en-GB',
      contactEmail: 'shop@northwind.demo',
      isDemo: true,
      domain: 'northwind.localhost',
    },
  },
  users: {
    aurumOwner: 'owner@aurum.demo',
    aurumViewer: 'viewer@aurum.demo',
    aurumStock: 'stock@aurum.demo',
    lumiereOwner: 'owner@lumiere.demo',
    northwindOwner: 'owner@northwind.demo',
    multi: 'multi@demo.local',
  },
} as const;

export interface SeedResult {
  tenantIds: Record<keyof typeof DEMO.tenants, string>;
  userIds: Record<keyof typeof DEMO.users | 'platformOwner' | 'platformSupport', string>;
  locationIds: { aurumMain: string; aurumMumbai: string; aurumJaipur: string };
}

async function createUser(tx: Tx, email: string, displayName: string, passwordHash: string): Promise<string> {
  const [row] = await tx
    .insert(users)
    .values({ email, displayName, passwordHash })
    .returning({ id: users.id });
  if (!row) throw new Error(`failed to create ${email}`);
  return row.id;
}

async function addMember(
  tx: Tx,
  tenantId: string,
  userId: string,
  roleIds: string[],
  locationScope: string[] | null = null,
): Promise<void> {
  const [m] = await tx
    .insert(memberships)
    .values({ tenantId, userId, locationScope })
    .returning({ id: memberships.id });
  if (!m) throw new Error('membership insert failed');
  await tx
    .insert(membershipRoles)
    .values(roleIds.map((roleId) => ({ tenantId, membershipId: m.id, roleId })));
}

export async function seedDemo(db: Db, password: string): Promise<SeedResult> {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production');
  if (password.length < 12) throw new Error('SEED_DEMO_PASSWORD must be at least 12 characters');
  const passwordHash = await hashPassword(password);

  return systemTx(db, async (tx) => {
    const existing = await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, DEMO.tenants.aurum.slug));
    if (existing.length)
      throw new Error('Demo data already present. Run `pnpm db:reset` for a clean database.');

    const platformOwner = await createUser(tx, DEMO.platform.owner, 'Platform Owner', passwordHash);
    const platformSupport = await createUser(tx, DEMO.platform.support, 'Platform Support', passwordHash);
    await tx.insert(platformAdmins).values([
      { userId: platformOwner, role: 'platform_owner' },
      { userId: platformSupport, role: 'platform_support' },
    ]);

    const provisioned: Record<string, Awaited<ReturnType<typeof provisionTenantRecords>>> = {};
    for (const [key, def] of Object.entries(DEMO.tenants)) {
      const { domain, ...rest } = def;
      const input: ProvisionTenantInput = {
        slug: rest.slug,
        displayName: rest.displayName,
        legalName: rest.legalName,
        preset: rest.preset,
        countryCode: rest.countryCode,
        defaultCurrency: rest.defaultCurrency,
        timezone: rest.timezone,
        defaultLocale: rest.defaultLocale,
        contactEmail: rest.contactEmail,
        isDemo: rest.isDemo,
      };
      const p = await provisionTenantRecords(tx, input);
      provisioned[key] = p;
      await tx.insert(channelDomains).values({
        tenantId: p.tenant.id,
        channelId: p.channelIds[0]!,
        hostname: domain,
        status: 'verified',
        isPrimary: true,
        verifiedAt: new Date(),
      });
      await writeAudit(tx, {
        tenantId: p.tenant.id,
        actorType: 'system',
        actorUserId: null,
        action: 'tenant.provisioned',
        entityType: 'tenant',
        entityId: p.tenant.id,
        newValues: { slug: input.slug, preset: input.preset, isDemo: true },
        reason: 'Demo seed',
      });
    }
    const aurum = provisioned.aurum!;
    const lumiere = provisioned.lumiere!;
    const northwind = provisioned.northwind!;

    // Unverified domain on Aurum: must never resolve.
    await tx.insert(channelDomains).values({
      tenantId: aurum.tenant.id,
      channelId: aurum.channelIds[0]!,
      hostname: DEMO.tenants.aurum.pendingDomain,
      status: 'pending',
    });
    // Keep tenants' brand names visible in themes.
    await tx
      .update(channels)
      .set({ name: 'Aurum wholesale portal' })
      .where(eq(channels.id, aurum.channelIds[0]!));

    const [mumbai] = await tx
      .insert(locations)
      .values({
        tenantId: aurum.tenant.id,
        storeId: aurum.storeId,
        code: 'mumbai-branch',
        name: 'Mumbai branch',
        type: 'branch',
        address: { line1: 'Zaveri Bazaar (demo address)', city: 'Mumbai', countryCode: 'IN' },
      })
      .returning({ id: locations.id });
    const [jaipur] = await tx
      .insert(locations)
      .values({
        tenantId: aurum.tenant.id,
        storeId: aurum.storeId,
        code: 'jaipur-branch',
        name: 'Jaipur branch',
        type: 'branch',
        address: { line1: 'Johari Bazaar (demo address)', city: 'Jaipur', countryCode: 'IN' },
      })
      .returning({ id: locations.id });

    const u = {
      aurumOwner: await createUser(tx, DEMO.users.aurumOwner, 'Asha Aurum (demo owner)', passwordHash),
      aurumViewer: await createUser(tx, DEMO.users.aurumViewer, 'Vikram Viewer (demo)', passwordHash),
      aurumStock: await createUser(tx, DEMO.users.aurumStock, 'Sana Stock (demo, Mumbai only)', passwordHash),
      lumiereOwner: await createUser(tx, DEMO.users.lumiereOwner, 'Leela Lumière (demo owner)', passwordHash),
      northwindOwner: await createUser(
        tx,
        DEMO.users.northwindOwner,
        'Nora Northwind (demo owner)',
        passwordHash,
      ),
      multi: await createUser(tx, DEMO.users.multi, 'Mani Multi-tenant (demo)', passwordHash),
    };

    await addMember(tx, aurum.tenant.id, u.aurumOwner, [aurum.rolesByKey.owner!.id]);
    await addMember(tx, aurum.tenant.id, u.aurumViewer, [aurum.rolesByKey.viewer!.id]);
    await addMember(
      tx,
      aurum.tenant.id,
      u.aurumStock,
      [aurum.rolesByKey.inventory_operator!.id],
      [mumbai!.id],
    );
    await addMember(tx, aurum.tenant.id, u.multi, [aurum.rolesByKey.catalog_editor!.id]);
    await addMember(tx, lumiere.tenant.id, u.lumiereOwner, [lumiere.rolesByKey.owner!.id]);
    await addMember(tx, northwind.tenant.id, u.northwindOwner, [northwind.rolesByKey.owner!.id]);
    await addMember(tx, northwind.tenant.id, u.multi, [northwind.rolesByKey.admin!.id]);

    return {
      tenantIds: { aurum: aurum.tenant.id, lumiere: lumiere.tenant.id, northwind: northwind.tenant.id },
      userIds: { ...u, platformOwner, platformSupport },
      locationIds: { aurumMain: aurum.locationId, aurumMumbai: mumbai!.id, aurumJaipur: jaipur!.id },
    };
  });
}
