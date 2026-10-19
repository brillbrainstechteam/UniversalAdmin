'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PriceQuote, RevalidateQuoteResponse } from '@uc/contracts';
import {
  Alert,
  Button,
  Card,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  StatusBadge,
  errorMessage,
  formatDateTime,
} from '@uc/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PricingTabs, QuoteLineView, money } from '../../../../../../lib/pricing';
import { useTenant, useTenantQuery } from '../../../../../../lib/tenant';

export default function QuotePage() {
  const { quoteId } = useParams<{ quoteId: string }>();
  const { api, can, tenantId, context } = useTenant();
  const qc = useQueryClient();
  const enabled = can('pricing.read') && context.features.includes('pricing');
  const tz = context.tenant.timezone;
  const quote = useTenantQuery<PriceQuote>(
    ['pricing', 'quote', quoteId],
    `/v1/admin/pricing/quotes/${quoteId}`,
    undefined,
    enabled,
  );
  const revalidate = useMutation({
    mutationFn: () =>
      api<RevalidateQuoteResponse>(`/v1/admin/pricing/quotes/${quoteId}/revalidate`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['t', tenantId, 'pricing'] }),
  });
  if (!enabled) return <ForbiddenState />;
  if (quote.error) return <ErrorState error={quote.error} onRetry={() => void quote.refetch()} />;
  if (!quote.data) return <LoadingState />;
  const q = quote.data;
  const r = revalidate.data;
  return (
    <>
      <PageHeader
        title={`Quote ${money(q.totalMinor, q.currency)}`}
        description={`Created ${formatDateTime(q.createdAt, tz)} by ${q.createdBy?.name ?? 'storefront visitor'} · valid until ${formatDateTime(q.expiresAt, tz)}${q.channel ? ` · ${q.channel.name}` : ''}`}
        actions={
          q.status !== 'superseded' && (
            <Button variant="primary" loading={revalidate.isPending} onClick={() => revalidate.mutate()}>
              Revalidate with current rates
            </Button>
          )
        }
      />
      <PricingTabs />
      <div className="uc-row">
        <StatusBadge status={q.status} />
        {q.supersededBy && (
          <Link href={`/t/${tenantId}/pricing/quotes/${q.supersededBy}`}>Replaced by a newer quote</Link>
        )}
      </div>
      {revalidate.error && <Alert tone="danger">{errorMessage(revalidate.error)}</Alert>}
      {r && r.status === 'unchanged' && r.quote.id === q.id && (
        <Alert tone="success">Price unchanged; this quote is still valid.</Alert>
      )}
      {r && (r.status === 'changed' || (r.status === 'unchanged' && r.quote.id !== q.id)) && (
        <Alert
          tone={r.status === 'changed' ? 'warning' : 'success'}
          title={r.status === 'changed' ? 'The price changed' : 'Re-issued at the same price'}
        >
          {money(r.previousTotalMinor, q.currency)} →{' '}
          {money(r.newTotalMinor ?? r.previousTotalMinor, r.quote.currency)}.{' '}
          <Link href={`/t/${tenantId}/pricing/quotes/${r.quote.id}`}>Open the new quote</Link>. This quote
          stays exactly as it was shown.
        </Alert>
      )}
      {r && r.status === 'unavailable' && (
        <Alert tone="danger" title="Cannot be priced now">
          {r.problems.map((p) => p.message).join(' ')}
        </Alert>
      )}
      <Card title="Totals">
        <dl className="uc-row" style={{ flexWrap: 'wrap', gap: 24 }}>
          <div>
            <dt className="uc-muted">Subtotal</dt>
            <dd className="uc-mono">{money(q.subtotalMinor, q.currency)}</dd>
          </div>
          <div>
            <dt className="uc-muted">Discount</dt>
            <dd className="uc-mono">−{money(q.discountMinor, q.currency)}</dd>
          </div>
          <div>
            <dt className="uc-muted">Tax</dt>
            <dd className="uc-mono">{money(q.taxMinor, q.currency)}</dd>
          </div>
          <div>
            <dt className="uc-muted">Total</dt>
            <dd className="uc-mono">
              <strong>{money(q.totalMinor, q.currency)}</strong>
            </dd>
          </div>
        </dl>
      </Card>
      {q.lines.map((l, i) => (
        <Card key={i} title={`Line ${i + 1}`}>
          <QuoteLineView line={l} />
        </Card>
      ))}
    </>
  );
}
