'use client';

import type { CurrentRates, MetalRate, Page, PriceBook } from '@uc/contracts';
import {
  Alert,
  Badge,
  Card,
  DataTable,
  EmptyState,
  ForbiddenState,
  PageHeader,
  formatDateTime,
} from '@uc/ui';
import Link from 'next/link';
import { PricingTabs, majorMoney } from '../../../../lib/pricing';
import { useTenant, useTenantQuery } from '../../../../lib/tenant';
import { RateDecisionButtons } from '../../../../lib/rates';

export default function PricingOverviewPage() {
  const { can, tenantId, context } = useTenant();
  const tz = context.tenant.timezone;
  const pricing = context.features.includes('pricing') && (can('pricing.read') || can('rates.read'));
  const ratesOn = context.features.includes('metal_rates') && can('rates.read');
  const current = useTenantQuery<CurrentRates>(
    ['rates', 'current'],
    '/v1/admin/rates/current',
    undefined,
    ratesOn,
  );
  const pending = useTenantQuery<Page<MetalRate>>(
    ['rates', 'list'],
    '/v1/admin/rates',
    { status: 'proposed', limit: 50 },
    ratesOn,
  );
  const books = useTenantQuery<{ items: PriceBook[] }>(
    ['pricing', 'books'],
    '/v1/admin/pricing/books',
    undefined,
    pricing && can('pricing.read'),
  );
  if (!pricing) return <ForbiddenState />;
  const staleCount = current.data?.items.filter((i) => i.stale).length ?? 0;
  const missing = current.data?.items.filter((i) => !i.rate).length ?? 0;
  return (
    <>
      <PageHeader
        title={context.features.includes('metal_rates') ? 'Pricing & metal rates' : 'Pricing'}
        description="Server-calculated prices from approved metal rates and versioned rules. Every price is explainable down to the rounding."
      />
      <PricingTabs />
      {ratesOn && (
        <>
          {staleCount > 0 && (
            <Alert tone="danger" title="Stale rates">
              {staleCount} current rate(s) are older than {current.data!.maxAgeMinutes} minutes.{' '}
              {current.data!.stalePolicy === 'block'
                ? 'Quotes that need them are blocked until a fresh rate is approved.'
                : 'Quotes still use them (fallback policy) and are flagged as stale.'}
            </Alert>
          )}
          <Card
            title="Current metal rates"
            actions={
              <Link className="uc-btn" data-size="sm" href={`/t/${tenantId}/pricing/rates`}>
                History & proposals
              </Link>
            }
          >
            {missing > 0 && (
              <span className="uc-muted">Purities without an approved rate cannot be priced by weight.</span>
            )}
            <DataTable
              caption="Current metal rates"
              rows={current.data?.items}
              isLoading={current.isLoading}
              error={current.error}
              onRetry={() => void current.refetch()}
              rowKey={(r) => r.purity.id}
              empty={
                <EmptyState
                  title="No active purities"
                  description="Add purities under Settings → Jewellery."
                />
              }
              columns={[
                { key: 'purity', header: 'Purity', render: (r) => `${r.metal} · ${r.purity.label}` },
                {
                  key: 'rate',
                  header: `Rate per gram`,
                  render: (r) =>
                    r.rate ? (
                      <span className="uc-mono">{majorMoney(r.rate.ratePerG, r.currency)}</span>
                    ) : (
                      <Badge tone="warning">No approved rate</Badge>
                    ),
                },
                {
                  key: 'source',
                  header: 'Source',
                  render: (r) =>
                    r.rate ? (
                      <span className="uc-row">
                        {r.rate.source.name}
                        {r.rate.source.simulated && <Badge tone="warning">SIMULATED</Badge>}
                        {r.rate.reason?.startsWith('DEMO') && <Badge tone="info">DEMO</Badge>}
                      </span>
                    ) : (
                      '—'
                    ),
                },
                {
                  key: 'asof',
                  header: 'Source time',
                  render: (r) => (r.rate ? formatDateTime(r.rate.sourceAsOf, tz) : '—'),
                },
                {
                  key: 'fresh',
                  header: 'Freshness',
                  render: (r) =>
                    !r.rate ? (
                      '—'
                    ) : r.stale ? (
                      <Badge tone="danger">Stale ({r.ageMinutes} min)</Badge>
                    ) : (
                      <Badge tone="success">Fresh</Badge>
                    ),
                },
                {
                  key: 'pending',
                  header: 'Waiting approval',
                  render: (r) => (r.pending ? <Badge tone="warning">{r.pending}</Badge> : '—'),
                },
              ]}
            />
          </Card>
          <Card title="Rate proposals waiting for approval">
            <DataTable
              caption="Rate proposals waiting for approval"
              rows={pending.data?.items}
              isLoading={pending.isLoading}
              error={pending.error}
              rowKey={(r) => r.id}
              empty={<EmptyState title="Nothing to approve" />}
              columns={[
                { key: 'purity', header: 'Purity', render: (r) => r.purity.label },
                {
                  key: 'value',
                  header: 'Proposed',
                  render: (r) => (
                    <span className="uc-mono">
                      {majorMoney(r.ratePerG, r.currency)}/g{' '}
                      {r.input.unit !== 'per_g' && (
                        <span className="uc-muted">
                          (entered {r.input.value} {r.input.unit.replace('_', ' ')})
                        </span>
                      )}
                    </span>
                  ),
                },
                {
                  key: 'by',
                  header: 'Proposed by',
                  render: (r) => `${r.proposedBy?.name ?? 'System'} · ${formatDateTime(r.proposedAt, tz)}`,
                },
                { key: 'reason', header: 'Reason', render: (r) => r.reason },
                { key: 'act', header: 'Decision', render: (r) => <RateDecisionButtons rate={r} /> },
              ]}
            />
          </Card>
        </>
      )}
      {can('pricing.read') && (
        <Card
          title="Price books"
          actions={
            <Link className="uc-btn" data-size="sm" href={`/t/${tenantId}/pricing/books`}>
              Manage books & rules
            </Link>
          }
        >
          <DataTable
            caption="Price books"
            rows={books.data?.items}
            isLoading={books.isLoading}
            error={books.error}
            rowKey={(b) => b.id}
            empty={
              <EmptyState title="No price books" description="Create a price book, then add rules to it." />
            }
            columns={[
              {
                key: 'name',
                header: 'Name',
                render: (b) => <Link href={`/t/${tenantId}/pricing/books/${b.id}`}>{b.name}</Link>,
              },
              { key: 'channel', header: 'Channel', render: (b) => b.channel?.name ?? 'All channels' },
              { key: 'prio', header: 'Priority', render: (b) => b.priority },
              { key: 'rules', header: 'Active rules', render: (b) => b.ruleCount },
              {
                key: 'status',
                header: 'Status',
                render: (b) => <Badge tone={b.status === 'active' ? 'success' : undefined}>{b.status}</Badge>,
              },
            ]}
          />
        </Card>
      )}
    </>
  );
}
