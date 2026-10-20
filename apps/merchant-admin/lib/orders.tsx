'use client';

import { useMutation } from '@tanstack/react-query';
import type { Contact, PriceQuote, PricingItemResults, QuoteLineInput } from '@uc/contracts';
import { Alert, Badge, Button, TextField, errorMessage } from '@uc/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { money } from './pricing';
import { useTenant, useTenantQuery } from './tenant';

const TABS = [
  { path: '', label: 'Orders' },
  { path: '/quotations', label: 'Quotations' },
  { path: '/returns', label: 'Returns' },
  { path: '/settings', label: 'Settings' },
] as const;

/** Secondary navigation under the single "Orders" nav entry. */
export function OrdersTabs() {
  const { tenantId } = useTenant();
  const pathname = usePathname();
  const base = `/t/${tenantId}/orders`;
  return (
    <nav aria-label="Order sections" className="uc-row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
      {TABS.map((t) => {
        const href = `${base}${t.path}`;
        const current =
          t.path === ''
            ? pathname === base ||
              (pathname.startsWith(`${base}/`) &&
                !pathname.startsWith(`${base}/quotations`) &&
                !pathname.startsWith(`${base}/returns`) &&
                !pathname.startsWith(`${base}/settings`))
            : pathname.startsWith(href);
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

const STATUS_TONE: Record<string, 'success' | 'danger' | 'warning' | 'info' | undefined> = {
  confirmed: 'success',
  paid: 'success',
  converted: 'success',
  accepted: 'success',
  awaiting_approval: 'warning',
  pending_payment: 'warning',
  pending: 'warning',
  sent: 'info',
  draft: 'info',
  on_hold: 'danger',
  failed: 'danger',
  refund_due: 'danger',
  fulfilled: 'success',
  delivered: 'success',
  succeeded: 'success',
  received: 'success',
  refunded: 'success',
  partial: 'warning',
  packed: 'info',
  shipped: 'info',
  requested: 'warning',
  approved: 'info',
  rejected: undefined,
  partially_refunded: 'info',
  not_sent: 'warning',
  unfulfilled: undefined,
  cancelled: undefined,
  expired: undefined,
  unpaid: undefined,
};
export function Status({ value }: { value: string }) {
  return <Badge tone={STATUS_TONE[value]}>{value.replace(/_/g, ' ')}</Badge>;
}

export const ORIGIN_LABELS = { storefront: 'Storefront', admin: 'Staff', quotation: 'Quotation' } as const;

export function ContactFields({
  value,
  onChange,
  errors,
}: {
  value: Contact;
  onChange: (c: Contact) => void;
  errors: Record<string, string>;
}) {
  return (
    <div className="uc-form-grid">
      <TextField
        label="Customer name"
        value={value.name}
        error={errors['contact.name']}
        onChange={(e) => onChange({ ...value, name: e.target.value })}
      />
      <TextField
        label="Customer email"
        type="email"
        value={value.email}
        error={errors['contact.email']}
        onChange={(e) => onChange({ ...value, email: e.target.value })}
      />
      <TextField
        label="Phone (optional)"
        value={value.phone ?? ''}
        onChange={(e) => onChange({ ...value, phone: e.target.value || null })}
      />
    </div>
  );
}

export interface DraftLine extends QuoteLineInput {
  label: string;
}

/** Find items (variants or exact pieces) and build lines; "Preview price" asks the server for a quote. */
export function LineBuilder({
  lines,
  onChange,
  channelId,
}: {
  lines: DraftLine[];
  onChange: (l: DraftLine[]) => void;
  channelId: string | null;
}) {
  const { api } = useTenant();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const found = useTenantQuery<PricingItemResults>(
    ['pricing', 'items'],
    '/v1/admin/pricing/items',
    { q: debounced },
    debounced.length > 0,
  );
  const linesKey = JSON.stringify([channelId, toLineInputs(lines)]);
  const preview = useMutation({
    mutationFn: async () => ({
      key: linesKey,
      quote: await api<PriceQuote>('/v1/admin/pricing/quotes', {
        method: 'POST',
        body: { channelId, lines: toLineInputs(lines) },
      }),
    }),
  });
  // A preview is shown only while the lines it was calculated for are unchanged.
  const shown = preview.data?.key === linesKey ? preview.data.quote : null;
  return (
    <div className="uc-stack">
      <TextField
        label="Add item (SKU, title or piece tag)"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {debounced && (
        <ul className="uc-stack" style={{ listStyle: 'none', padding: 0 }} aria-label="Matching items">
          {found.data?.items.slice(0, 8).map((i) => {
            const taken = lines.some(
              (l) => l.variantId === i.variantId && (l.serialItemId ?? null) === i.serialItemId,
            );
            return (
              <li key={`${i.variantId}:${i.serialItemId ?? ''}`}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={taken}
                  onClick={() =>
                    onChange([
                      ...lines,
                      {
                        variantId: i.variantId,
                        ...(i.serialItemId ? { serialItemId: i.serialItemId } : {}),
                        quantity: 1,
                        label: `${i.serialTag ? `Piece ${i.serialTag} · ` : ''}${i.sku} · ${i.title}`,
                      },
                    ])
                  }
                >
                  Add {i.serialTag ? `piece ${i.serialTag}` : i.sku}
                  <span className="uc-muted"> · {i.title}</span>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {lines.length === 0 ? (
        <span className="uc-muted">No lines yet.</span>
      ) : (
        <ul className="uc-stack" style={{ listStyle: 'none', padding: 0 }} aria-label="Order lines">
          {lines.map((l, i) => (
            <li
              key={`${l.variantId}:${l.serialItemId ?? ''}`}
              className="uc-row"
              style={{ flexWrap: 'wrap' }}
            >
              <span>{l.label}</span>
              {l.serialItemId ? (
                <span className="uc-muted">× 1 (exact piece)</span>
              ) : (
                <TextField
                  label={`Quantity for ${l.label}`}
                  inputMode="numeric"
                  value={String(l.quantity)}
                  onChange={(e) =>
                    onChange(
                      lines.map((x, j) =>
                        j === i
                          ? {
                              ...x,
                              quantity: /^\d{1,5}$/.test(e.target.value)
                                ? Number.parseInt(e.target.value, 10)
                                : 0,
                            }
                          : x,
                      ),
                    )
                  }
                />
              )}
              <Button size="sm" onClick={() => onChange(lines.filter((_, j) => j !== i))}>
                Remove<span className="uc-sr-only"> {l.label}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="uc-row">
        <Button disabled={!lines.length} loading={preview.isPending} onClick={() => preview.mutate()}>
          Preview price
        </Button>
        {shown && (
          <span>
            Server price now: <strong className="uc-mono">{money(shown.totalMinor, shown.currency)}</strong>
            <span className="uc-muted"> (final price is calculated when you save)</span>
          </span>
        )}
      </div>
      {preview.error && <Alert tone="danger">{errorMessage(preview.error)}</Alert>}
    </div>
  );
}

export const toLineInputs = (lines: DraftLine[]): QuoteLineInput[] =>
  lines.map(({ variantId, serialItemId, quantity }) => ({
    variantId,
    ...(serialItemId ? { serialItemId } : {}),
    quantity,
  }));
