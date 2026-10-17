'use client';

import { useQuery } from '@tanstack/react-query';
import { PRESETS, type AdminContext } from '@uc/contracts';
import { apiRequest, ApiError, AppShell, Badge, Card, ErrorState, LoadingState } from '@uc/ui';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { LogoutButton } from '../../../lib/logout';
import { TenantProvider, useAuthRedirect } from '../../../lib/tenant';

export default function TenantLayout({ children }: { children: ReactNode }) {
  const { tenantId } = useParams<{ tenantId: string }>();
  const pathname = usePathname();
  const context = useQuery({
    queryKey: ['context', tenantId],
    queryFn: () => apiRequest<AdminContext>('/v1/admin/context', { tenantId }),
  });
  useAuthRedirect(context.error);

  if (context.isLoading) {
    return (
      <main className="uc-content">
        <LoadingState label="Loading merchant" />
      </main>
    );
  }
  if (context.error || !context.data) {
    const e = context.error;
    const title =
      e instanceof ApiError && e.code === 'TENANT_SUSPENDED'
        ? 'This merchant account is suspended'
        : e instanceof ApiError && e.code === 'TENANT_ACCESS_DENIED'
          ? 'You don’t have access to this merchant'
          : null;
    return (
      <main className="uc-content" style={{ maxWidth: 640, margin: '0 auto' }}>
        {title ? (
          <Card title={title}>
            <p className="uc-muted">{(e as ApiError).message}</p>
            <Link href="/">Choose another merchant</Link>
          </Card>
        ) : (
          <ErrorState error={e} onRetry={() => void context.refetch()} />
        )}
      </main>
    );
  }

  const ctx = context.data;
  const base = `/t/${tenantId}`;
  const item = (n: (typeof ctx.nav)[number]) => {
    const href = `${base}${n.path}`;
    return {
      key: n.key,
      label: n.label,
      href,
      active: n.path === '' ? pathname === base : pathname.startsWith(href),
    };
  };

  return (
    <TenantProvider tenantId={tenantId} context={ctx}>
      <AppShell
        brand={ctx.tenant.displayName}
        subtitle={PRESETS[ctx.tenant.preset].label}
        sections={[
          { items: ctx.nav.filter((n) => n.section === 'main').map(item) },
          { heading: 'Settings', items: ctx.nav.filter((n) => n.section === 'settings').map(item) },
        ]}
        banner={
          ctx.tenant.isDemo ? (
            <div className="uc-demo-banner">Demo merchant — all data here is illustrative demo data.</div>
          ) : undefined
        }
        topbar={
          <div className="uc-row" style={{ marginLeft: 'auto' }}>
            <Badge>{ctx.membership.roles.map((r) => r.name).join(', ')}</Badge>
            {ctx.membership.locationScope && (
              <Badge tone="info">{ctx.membership.locationScope.length} location(s) only</Badge>
            )}
            <span className="uc-muted">{ctx.user.email}</span>
            <Link className="uc-btn" data-size="sm" href="/">
              Switch merchant
            </Link>
            <LogoutButton />
          </div>
        }
        renderLink={({ href, children, active, onClick }) => (
          <Link href={href} aria-current={active ? 'page' : undefined} onClick={onClick}>
            {children}
          </Link>
        )}
      >
        {children}
      </AppShell>
    </TenantProvider>
  );
}
