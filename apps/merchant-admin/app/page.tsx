'use client';

import { PRESETS, type PresetKey } from '@uc/contracts';
import { Badge, Card, EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge } from '@uc/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { LogoutButton } from '../lib/logout';
import { useMe } from '../lib/tenant';

/** Merchant picker: every action later resolves an explicit tenant (specs/00 personas). */
export default function TenantPickerPage() {
  const me = useMe();
  const router = useRouter();
  const memberships = me.data?.memberships ?? [];
  const single =
    memberships.length === 1 && memberships[0]?.tenantStatus === 'active' ? memberships[0] : null;
  useEffect(() => {
    if (single) router.replace(`/t/${single.tenantId}`);
  }, [single, router]);

  return (
    <main className="uc-content" style={{ margin: '0 auto', maxWidth: 720 }}>
      <PageHeader
        title="Choose a merchant"
        description={me.data ? `Signed in as ${me.data.user.email}` : undefined}
        actions={<LogoutButton />}
      />
      {me.isLoading || single ? (
        <LoadingState />
      ) : me.error ? (
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      ) : memberships.length === 0 ? (
        <Card>
          <EmptyState
            title="No merchant access yet"
            description="Ask a merchant owner to invite you, then open the invitation link."
          />
        </Card>
      ) : (
        <ul className="uc-stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {memberships.map((m) => (
            <li key={m.tenantId}>
              <Card
                title={
                  m.tenantStatus === 'active' ? (
                    <Link href={`/t/${m.tenantId}`}>
                      <h2>{m.tenantName}</h2>
                    </Link>
                  ) : (
                    <h2>{m.tenantName}</h2>
                  )
                }
                actions={
                  <>
                    {m.isDemo && <Badge tone="warning">Demo data</Badge>}
                    <StatusBadge status={m.tenantStatus} />
                  </>
                }
              >
                <span className="uc-muted">
                  {PRESETS[m.preset as PresetKey]?.label} · Roles: {m.roles.map((r) => r.name).join(', ')}
                </span>
                {m.tenantStatus !== 'active' && (
                  <span className="uc-muted">This merchant is suspended. Contact platform support.</span>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
