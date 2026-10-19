'use client';

import { Alert, Card, PageHeader } from '@uc/ui';
import Link from 'next/link';
import { useBuyer } from '../../lib/buyer';

export default function HomePage() {
  const { me, money } = useBuyer();
  const c = me.company;
  if (!c) return <PageHeader title="No company" description="Your buyer access is not active." />;
  return (
    <>
      <PageHeader
        title={c.name}
        description={`Signed in as ${me.user.displayName} (${c.role}). Prices you see are your company's contract prices.`}
      />
      {c.status !== 'active' && (
        <Alert tone="warning">
          Your company account is {c.status.replace('_', ' ')}: new orders are paused. Contact your supplier.
        </Alert>
      )}
      <Card title="Account">
        <dl className="uc-row" style={{ flexWrap: 'wrap', gap: 24 }}>
          <div>
            <dt className="uc-muted">Terms</dt>
            <dd>{c.paymentTerms === 'prepaid' ? 'Prepaid (advances)' : 'On account'}</dd>
          </div>
          <div>
            <dt className="uc-muted">Credit available</dt>
            <dd className="uc-mono">
              {c.credit.availableMinor === null ? 'No limit' : money(c.credit.availableMinor)}
            </dd>
          </div>
          <div>
            <dt className="uc-muted">Outstanding</dt>
            <dd className="uc-mono">{money(c.credit.exposureMinor)}</dd>
          </div>
          <div>
            <dt className="uc-muted">Minimum order</dt>
            <dd className="uc-mono">{c.minOrderMinor ? money(c.minOrderMinor) : 'None'}</dd>
          </div>
          <div>
            <dt className="uc-muted">Your order limit</dt>
            <dd className="uc-mono">
              {c.orderLimitMinor ? `${money(c.orderLimitMinor)} (above: approver decides)` : 'None'}
            </dd>
          </div>
        </dl>
      </Card>
      <Card title="Delivery locations">
        <ul>
          {c.locations.map((l) => (
            <li key={l.id}>
              <strong>{l.name}</strong> — {l.address.line1}, {l.address.city}
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Start">
        <div className="uc-row" style={{ flexWrap: 'wrap' }}>
          <Link className="uc-btn" data-variant="primary" href="/order">
            Quick order by SKU
          </Link>
          <Link className="uc-btn" href="/catalog">
            Browse catalog
          </Link>
          <Link className="uc-btn" href="/rfqs/new">
            Request a quote
          </Link>
        </div>
      </Card>
    </>
  );
}
