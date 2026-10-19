'use client';

import { formatMinor, type PriceBreakdown, type QuoteLine } from '@uc/contracts';
import { Alert, Badge, formatDateTime } from '@uc/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTenant } from './tenant';

const TABS = [
  { path: '', label: 'Overview', feature: null },
  { path: '/rates', label: 'Metal rates', feature: 'metal_rates' },
  { path: '/books', label: 'Price books & rules', feature: null },
  { path: '/calculator', label: 'Calculator', feature: null },
  { path: '/quotes', label: 'Quotes', feature: null },
  { path: '/settings', label: 'Settings & tax', feature: null },
] as const;

/** Secondary navigation for the single "Pricing & Metal Rates" nav entry. */
export function PricingTabs() {
  const { tenantId, context } = useTenant();
  const pathname = usePathname();
  const base = `/t/${tenantId}/pricing`;
  return (
    <nav aria-label="Pricing sections" className="uc-row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
      {TABS.filter((t) => !t.feature || context.features.includes(t.feature)).map((t) => {
        const href = `${base}${t.path}`;
        const current =
          t.path === ''
            ? pathname === base
            : pathname.startsWith(href) || (t.path === '/books' && pathname.startsWith(`${base}/rules`));
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

/**
 * Integer minor units → localised currency text. The decimal string is formatted directly (Intl accepts numeric
 * strings), so no float conversion happens in the browser.
 */
export function money(amountMinor: string, currency: string, minorUnits = 2): string {
  const major = formatMinor(amountMinor, minorUnits);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: minorUnits,
    }).format(major as unknown as number);
  } catch {
    return `${currency} ${major}`;
  }
}

/** A major-unit decimal string (rates, amounts in rules) shown with its currency. */
export function majorMoney(value: string, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 6 }).format(
      value as unknown as number,
    );
  } catch {
    return `${currency} ${value}`;
  }
}

export function RateProvenance({ rate }: { rate: QuoteLine['rate'] }) {
  const { context } = useTenant();
  if (!rate) return <span className="uc-muted">No metal rate used</span>;
  return (
    <span className="uc-row" style={{ flexWrap: 'wrap' }}>
      <span>
        Rate <span className="uc-mono">{majorMoney(rate.ratePerG, rate.currency)}/g</span> from{' '}
        {rate.sourceName}, as of {formatDateTime(rate.sourceAsOf, context.tenant.timezone)}
      </span>
      {rate.simulated && <Badge tone="warning">SIMULATED</Badge>}
      {rate.stale ? <Badge tone="danger">Stale</Badge> : <Badge tone="success">Fresh</Badge>}
    </span>
  );
}

/** Explainable breakdown: every component with its formula, exact value and rounded amount. */
export function BreakdownTable({ breakdown, caption }: { breakdown: PriceBreakdown; caption?: string }) {
  const m = (v: string) => money(v, breakdown.currency, breakdown.minorUnits);
  const hasDiscount = breakdown.discountMinor !== '0';
  return (
    <div className="uc-stack">
      <div className="uc-table-wrap">
        <table className="uc-table">
          <caption className="uc-sr-only">{caption ?? 'Price breakdown'}</caption>
          <thead>
            <tr>
              <th scope="col">Component</th>
              <th scope="col">Calculation</th>
              <th scope="col">Exact</th>
              <th scope="col">Amount</th>
              {hasDiscount && <th scope="col">Discount</th>}
            </tr>
          </thead>
          <tbody>
            {breakdown.components.map((c) => (
              <tr key={c.code}>
                <td>{c.label}</td>
                <td className="uc-mono">{c.formula}</td>
                <td className="uc-mono uc-muted">{c.exact}</td>
                <td className="uc-mono">{m(c.amountMinor)}</td>
                {hasDiscount && (
                  <td className="uc-mono">{c.discountMinor === '0' ? '—' : `−${m(c.discountMinor)}`}</td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={3}>
                Subtotal
              </th>
              <td className="uc-mono">{m(breakdown.subtotalMinor)}</td>
              {hasDiscount && <td />}
            </tr>
            {hasDiscount && (
              <tr>
                <th scope="row" colSpan={3}>
                  Discount
                </th>
                <td className="uc-mono">−{m(breakdown.discountMinor)}</td>
                <td />
              </tr>
            )}
            {breakdown.tax && (
              <tr>
                <th scope="row" colSpan={3}>
                  {breakdown.tax.label} ({breakdown.tax.ratePercent}% of {m(breakdown.tax.baseMinor)}){' '}
                  {breakdown.tax.status === 'pending_validation' && (
                    <Badge tone="warning">pending validation</Badge>
                  )}
                </th>
                <td className="uc-mono">{m(breakdown.taxMinor)}</td>
                {hasDiscount && <td />}
              </tr>
            )}
            <tr>
              <th scope="row" colSpan={3}>
                Total
              </th>
              <td className="uc-mono">
                <strong>{m(breakdown.totalMinor)}</strong>
              </td>
              {hasDiscount && <td />}
            </tr>
          </tfoot>
        </table>
      </div>
      <span className="uc-muted">
        Each component is rounded once to the currency&apos;s smallest unit (half-up).
      </span>
      {breakdown.warnings.map((w) => (
        <Alert key={w} tone="warning">
          {w}
        </Alert>
      ))}
    </div>
  );
}

/** One priced line: what was priced, with which book/rule/rate, and the breakdown. */
export function QuoteLineView({
  line,
  ruleLink = true,
}: {
  line: QuoteLine | (Omit<QuoteLine, 'sku'> & { sku: string | null });
  ruleLink?: boolean;
}) {
  const { tenantId } = useTenant();
  const meas = line.measurements;
  return (
    <div className="uc-stack">
      <div className="uc-row" style={{ flexWrap: 'wrap' }}>
        <strong>{line.title}</strong>
        {line.sku && <span className="uc-mono uc-muted">{line.sku}</span>}
        <span>× {line.quantity}</span>
      </div>
      <dl className="uc-row" style={{ flexWrap: 'wrap', gap: 16 }}>
        <div>
          <dt className="uc-muted">Weights (g)</dt>
          <dd className="uc-mono">
            gross {meas.grossG ?? '—'} · net {meas.netG ?? '—'} · fine {meas.fineG ?? '—'}
          </dd>
        </div>
        <div>
          <dt className="uc-muted">Billing basis</dt>
          <dd>{meas.billingBasis ?? '—'}</dd>
        </div>
        <div>
          <dt className="uc-muted">Purity</dt>
          <dd>{meas.purity ?? '—'}</dd>
        </div>
        <div>
          <dt className="uc-muted">Price book / rule</dt>
          <dd>
            {line.book.name} ·{' '}
            {ruleLink ? (
              <Link href={`/t/${tenantId}/pricing/rules/${line.rule.id}`}>{line.rule.name}</Link>
            ) : (
              line.rule.name
            )}{' '}
            v{line.rule.version}{' '}
            {line.rule.status !== 'published' && <Badge tone="warning">{line.rule.status}</Badge>}
          </dd>
        </div>
      </dl>
      <RateProvenance rate={line.rate} />
      <BreakdownTable breakdown={line.breakdown} caption={`Breakdown for ${line.title}`} />
    </div>
  );
}

export const RATE_UNIT_LABELS = {
  per_g: 'per gram',
  per_10g: 'per 10 grams',
  per_kg: 'per kilogram',
} as const;
