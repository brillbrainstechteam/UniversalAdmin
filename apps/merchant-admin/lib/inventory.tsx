'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatQty, type Location, type Page, type StockLevel } from '@uc/contracts';
import { TextField, useToast } from '@uc/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useTenant, useTenantQuery } from './tenant';

const TABS = [
  { path: '', label: 'Stock levels' },
  { path: '/reservations', label: 'Reservations' },
  { path: '/transfers', label: 'Transfers' },
  { path: '/counts', label: 'Stocktakes' },
  { path: '/movements', label: 'Ledger' },
  { path: '/issues', label: 'Issues' },
  { path: '/settings', label: 'Settings' },
] as const;

/** Secondary navigation between the inventory screens (all under the single Inventory nav entry). */
export function InventoryTabs() {
  const { tenantId } = useTenant();
  const pathname = usePathname();
  const base = `/t/${tenantId}/inventory`;
  return (
    <nav aria-label="Inventory sections" className="uc-row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
      {TABS.map((t) => {
        const href = `${base}${t.path}`;
        const current = t.path === '' ? pathname === base : pathname.startsWith(href);
        return (
          <Link
            key={t.path}
            href={href}
            className="uc-btn"
            data-size="sm"
            data-variant={current ? 'primary' : 'ghost'}
            aria-current={current ? 'page' : undefined}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Active locations visible to this member (location scope is applied by the API). */
export function useLocations(enabled = true) {
  const q = useTenantQuery<Page<Location>>(
    ['locations', 'all'],
    '/v1/admin/locations',
    { limit: 100 },
    enabled,
  );
  return {
    ...q,
    locations: q.data?.items ?? [],
    options: (q.data?.items ?? [])
      .filter((l) => l.status === 'active')
      .map((l) => ({ value: l.id, label: `${l.name} (${l.code})` })),
  };
}

export const qtyText = (value: string | null | undefined, unit: 'pcs' | 'g' = 'pcs') =>
  `${formatQty(value, unit)}${unit === 'g' ? ' g' : ''}`;

export const MOVEMENT_LABELS: Record<string, string> = {
  receipt: 'Receipt',
  adjustment: 'Adjustment',
  condition_change: 'Condition change',
  transfer_dispatch: 'Transfer dispatched',
  transfer_receive: 'Transfer received',
  transfer_cancel: 'Transfer cancelled',
  stocktake: 'Stocktake',
  reservation_hold: 'Hold',
  reservation_release: 'Hold released',
  reservation_expire: 'Hold expired',
  reservation_commit: 'Hold committed',
  commitment_release: 'Commitment released',
  write_off: 'Write-off',
};

export const ADJUSTMENT_REASON_OPTIONS = [
  { value: 'count_correction', label: 'Count correction' },
  { value: 'damage', label: 'Damage' },
  { value: 'loss', label: 'Loss' },
  { value: 'theft', label: 'Theft' },
  { value: 'found', label: 'Found stock' },
  { value: 'data_correction', label: 'Data correction' },
  { value: 'sample', label: 'Sample / display' },
  { value: 'other', label: 'Other' },
];

/** SKU search over stock levels; calls onPick with the chosen variant. */
export function VariantPicker({
  label = 'Find SKU or product',
  onPick,
  exclude = [],
}: {
  label?: string;
  onPick: (v: StockLevel) => void;
  exclude?: string[];
}) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const results = useTenantQuery<Page<StockLevel>>(
    ['inventory', 'levels', 'picker'],
    '/v1/admin/inventory/levels',
    { q: debounced, limit: 8 },
    debounced.length >= 2,
  );
  const items = (results.data?.items ?? []).filter((i) => !exclude.includes(i.variantId));
  return (
    <div className="uc-stack">
      <TextField
        label={label}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Type at least 2 characters"
      />
      {debounced.length >= 2 && (
        <ul
          className="uc-stack"
          style={{ listStyle: 'none', padding: 0, margin: 0 }}
          aria-label="Matching variants"
        >
          {results.isLoading && <li className="uc-muted">Searching…</li>}
          {!results.isLoading && items.length === 0 && <li className="uc-muted">No matching variants</li>}
          {items.map((i) => (
            <li key={i.variantId}>
              <button
                type="button"
                className="uc-btn"
                data-size="sm"
                data-variant="ghost"
                onClick={() => {
                  onPick(i);
                  setQ('');
                }}
              >
                <span className="uc-mono">{i.sku}</span>&nbsp;· {i.productTitle}
                {i.variantTitle ? ` · ${i.variantTitle}` : ''} — ATP {qtyText(i.atp, i.unit)}
                {i.tracking === 'serial' ? ' (pieces)' : ''}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Mutation that refreshes every cached query of this tenant (stock figures change everywhere) and toasts. */
export function useInventoryAction<TInput, TResult>(
  fn: (input: TInput) => Promise<TResult>,
  success: string | ((r: TResult) => string),
  onDone?: (r: TResult) => void,
) {
  const qc = useQueryClient();
  const { tenantId } = useTenant();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['t', tenantId] });
      toast(typeof success === 'string' ? success : success(r));
      onDone?.(r);
    },
  });
}
