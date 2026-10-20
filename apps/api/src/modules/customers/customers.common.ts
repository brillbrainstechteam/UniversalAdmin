import type { CustomerAddress, MarketingPreferences } from '@uc/contracts';
import { consentEvents, customerAddresses, type Tx } from '@uc/db';
import { asc, desc, eq } from 'drizzle-orm';
import type { Address } from '@uc/contracts';

/** Current marketing preference per channel = the latest consent event (none → not granted). */
export async function currentPreferences(tx: Tx, customerId: string): Promise<MarketingPreferences> {
  const rows = await tx
    .select()
    .from(consentEvents)
    .where(eq(consentEvents.customerId, customerId))
    .orderBy(desc(consentEvents.seq));
  const latest = (ch: 'email' | 'sms' | 'whatsapp') => rows.find((r) => r.channel === ch)?.granted ?? false;
  return { email: latest('email'), sms: latest('sms'), whatsapp: latest('whatsapp') };
}

export async function consentHistory(tx: Tx, customerId: string) {
  const rows = await tx
    .select()
    .from(consentEvents)
    .where(eq(consentEvents.customerId, customerId))
    .orderBy(desc(consentEvents.seq));
  return rows.map((r) => ({
    channel: r.channel,
    purpose: r.purpose,
    granted: r.granted,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function addressesOf(tx: Tx, customerId: string): Promise<CustomerAddress[]> {
  const rows = await tx
    .select()
    .from(customerAddresses)
    .where(eq(customerAddresses.customerId, customerId))
    .orderBy(desc(customerAddresses.isDefault), asc(customerAddresses.createdAt));
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    address: r.address as Address,
    isDefault: r.isDefault,
    version: r.version,
  }));
}
