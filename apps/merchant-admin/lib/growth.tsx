'use client';

import type { Channel, Page } from '@uc/contracts';
import { SelectField } from '@uc/ui';
import { useEffect } from 'react';
import { useTenantQuery } from './tenant';

/** Storefront channels (B2C and B2B) of this merchant. */
export function useStorefrontChannels(enabled = true) {
  const q = useTenantQuery<Page<Channel>>(['channels', 'all'], '/v1/admin/channels', { limit: 100 }, enabled);
  const items = (q.data?.items ?? []).filter(
    (c) => c.type === 'b2c_storefront' || c.type === 'b2b_storefront',
  );
  return { ...q, channels: items };
}

/** Channel picker that selects the first storefront channel by default. */
export function ChannelPicker({
  value,
  onChange,
  channels,
}: {
  value: string;
  onChange: (id: string) => void;
  channels: Channel[];
}) {
  useEffect(() => {
    if (!value && channels[0]) onChange(channels[0].id);
  }, [value, channels, onChange]);
  if (channels.length <= 1) return null;
  return (
    <SelectField
      label="Storefront"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      options={channels.map((c) => ({ value: c.id, label: c.name }))}
    />
  );
}

/** Major units → minor units exactly ("12.50" → "1250"); null when empty, 'invalid' when malformed. */
export function majorToMinor(v: string, mu = 2): string | null {
  const t = v.trim();
  if (!t) return null;
  if (!new RegExp(`^\\d{1,15}(\\.\\d{1,${mu}})?$`).test(t)) return 'invalid';
  const [w, f = ''] = t.split('.');
  return `${w}${f.padEnd(mu, '0')}`.replace(/^0+(?=\d)/, '');
}

/** Local datetime-input value ↔ ISO instant. */
export const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);
