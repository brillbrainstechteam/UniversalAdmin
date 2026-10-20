'use client';

import { FEATURES, type HomeSummary } from '@uc/contracts';
import { Badge, Card, ErrorState, LoadingState, PageHeader, formatDateTime } from '@uc/ui';
import Link from 'next/link';
import { SetupChecklistCard } from '../../../lib/launch';
import { useTenant, useTenantQuery } from '../../../lib/tenant';

export default function HomePage() {
  const { tenantId, context } = useTenant();
  const home = useTenantQuery<HomeSummary>(['home'], '/v1/admin/home');
  const tz = context.tenant.timezone;

  return (
    <>
      <PageHeader
        title="Home"
        description={
          home.data ? `Live figures as of ${formatDateTime(home.data.generatedAt, tz)} (${tz})` : undefined
        }
        actions={
          <button className="uc-btn" onClick={() => void home.refetch()} disabled={home.isFetching}>
            {home.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />
      {home.isLoading ? (
        <LoadingState />
      ) : home.error ? (
        <ErrorState error={home.error} onRetry={() => void home.refetch()} />
      ) : home.data ? (
        <>
          <section className="uc-grid" aria-label="Foundation summary">
            {(
              [
                ['Stores', home.data.counts.stores],
                ['Channels (active)', `${home.data.counts.activeChannels} / ${home.data.counts.channels}`],
                ['Locations', home.data.counts.locations],
                ['Active staff', home.data.counts.activeMembers],
                ['Pending invitations', home.data.counts.pendingInvitations],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="uc-card uc-stat">
                <span className="uc-muted">{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </section>
          <SetupChecklistCard compact />
          <Card title="Enabled capabilities">
            <p className="uc-muted" style={{ margin: 0 }}>
              Features entitled for this merchant by its plan/preset. Modules appear in navigation as each
              platform phase is delivered.
            </p>
            <div className="uc-row">
              {context.features.map((f) => (
                <Badge key={f}>{FEATURES[f].label}</Badge>
              ))}
            </div>
          </Card>
          {context.permissions.includes('audit.read') && (
            <Card title="Recent activity" actions={<Link href={`/t/${tenantId}/audit`}>View audit log</Link>}>
              {home.data.recentActivity.length === 0 ? (
                <p className="uc-muted">No activity recorded yet.</p>
              ) : (
                <ul className="uc-stack" style={{ margin: 0, paddingLeft: 18 }}>
                  {home.data.recentActivity.map((e) => (
                    <li key={e.id}>
                      <span className="uc-mono">{e.action}</span> by {e.actor?.email ?? e.actorType} ·{' '}
                      {formatDateTime(e.createdAt, tz)}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </>
      ) : null}
    </>
  );
}
