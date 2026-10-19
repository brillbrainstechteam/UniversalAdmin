'use client';

import { useMutation } from '@tanstack/react-query';
import type { CalculateResponse, PriceQuote, PricingCatalogOptions, PricingItemResults } from '@uc/contracts';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ForbiddenState,
  PageHeader,
  SelectField,
  TextField,
  errorMessage,
} from '@uc/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PricingTabs, QuoteLineView } from '../../../../../lib/pricing';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

type Item = PricingItemResults['items'][number];

export default function CalculatorPage() {
  const { api, can, tenantId, context } = useTenant();
  const router = useRouter();
  const enabled = can('pricing.read') && context.features.includes('pricing');
  const options = useTenantQuery<PricingCatalogOptions>(
    ['pricing', 'options'],
    '/v1/admin/pricing/options',
    undefined,
    enabled,
  );
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
    enabled && debounced.length > 0,
  );
  const [item, setItem] = useState<Item | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [channelId, setChannelId] = useState('');
  const line = item
    ? {
        variantId: item.variantId,
        ...(item.serialItemId ? { serialItemId: item.serialItemId } : {}),
        quantity: item.serialItemId ? 1 : /^\d{1,5}$/.test(quantity) ? Number.parseInt(quantity, 10) : 0,
      }
    : null;
  const calc = useMutation({
    mutationFn: () =>
      api<CalculateResponse>('/v1/admin/pricing/calculate', {
        method: 'POST',
        body: { channelId: channelId || null, line },
      }),
  });
  const quote = useMutation({
    mutationFn: () =>
      api<PriceQuote>('/v1/admin/pricing/quotes', {
        method: 'POST',
        body: { channelId: channelId || null, lines: [line] },
      }),
    onSuccess: (qt) => router.push(`/t/${tenantId}/pricing/quotes/${qt.id}`),
  });
  if (!enabled) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="Price calculator"
        description="Exactly what a buyer would be charged now, with every step shown. Calculating stores nothing; a quote freezes the price until it expires."
      />
      <PricingTabs />
      <Card title="Item">
        <div className="uc-form-grid">
          <TextField
            label="Find by SKU, title or piece tag"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. AUR-T-0001"
          />
          <SelectField
            label="Channel"
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            options={[
              { value: '', label: 'No specific channel' },
              ...(options.data?.channels ?? []).map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          {item && !item.serialItemId && (
            <TextField
              label="Quantity (pieces)"
              inputMode="numeric"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          )}
        </div>
        {debounced && (
          <ul className="uc-stack" style={{ listStyle: 'none', padding: 0 }} aria-label="Matching items">
            {found.data?.items.length === 0 && <EmptyState title="No matching items" />}
            {found.data?.items.map((i) => (
              <li key={`${i.variantId}:${i.serialItemId ?? ''}`}>
                <Button
                  size="sm"
                  variant={
                    item?.variantId === i.variantId && item?.serialItemId === i.serialItemId
                      ? 'primary'
                      : 'ghost'
                  }
                  onClick={() => {
                    setItem(i);
                    calc.reset();
                  }}
                >
                  {i.serialTag ? `Piece ${i.serialTag} · ` : ''}
                  <span className="uc-mono">{i.sku}</span> · {i.title}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="uc-row">
          <Button variant="primary" disabled={!line} loading={calc.isPending} onClick={() => calc.mutate()}>
            Calculate
          </Button>
          <Button disabled={!calc.data} loading={quote.isPending} onClick={() => quote.mutate()}>
            Save as quote
          </Button>
        </div>
        {calc.error && <Alert tone="danger">{errorMessage(calc.error)}</Alert>}
        {quote.error && <Alert tone="danger">{errorMessage(quote.error)}</Alert>}
      </Card>
      {calc.data && (
        <Card title="Breakdown">
          <QuoteLineView line={{ ...calc.data.line, variantId: calc.data.line.variantId ?? '' }} />
        </Card>
      )}
    </>
  );
}
