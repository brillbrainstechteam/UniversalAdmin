import type { Tx } from './client';
import { consentEvents, customerAddresses, customers } from './b2c-schema';

/**
 * Demo storefront customer for Lumière (DEMO data): one account with a saved address and recorded marketing
 * choices (e-mail yes, SMS/WhatsApp no). The e-mail is not verified (no e-mail connector until Phase 11).
 */
export async function seedDemoCustomers(
  tx: Tx,
  input: { tenantId: string; passwordHash: string },
): Promise<void> {
  const [c] = await tx
    .insert(customers)
    .values({
      tenantId: input.tenantId,
      email: 'customer@lumiere.demo',
      passwordHash: input.passwordHash,
      displayName: 'Meera Shah (demo customer)',
      phone: '+91 90000 00000',
      isDemo: true,
    })
    .returning({ id: customers.id });
  await tx.insert(customerAddresses).values({
    tenantId: input.tenantId,
    customerId: c!.id,
    label: 'Home (demo)',
    address: { line1: '12 Demo Lane', city: 'Pune', postalCode: '411001', countryCode: 'IN' },
    isDefault: true,
  });
  await tx.insert(consentEvents).values(
    (['email', 'sms', 'whatsapp'] as const).map((channel) => ({
      tenantId: input.tenantId,
      customerId: c!.id,
      channel,
      purpose: 'marketing' as const,
      granted: channel === 'email',
      source: 'registration' as const,
    })),
  );
}
