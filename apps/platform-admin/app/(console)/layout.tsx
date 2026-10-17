'use client';

import { AppShell, Badge, ErrorState, LoadingState } from '@uc/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { LogoutButton, usePlatformMe } from '../../lib/platform';

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  const me = usePlatformMe();
  const pathname = usePathname();
  if (me.isLoading)
    return (
      <main className="uc-content">
        <LoadingState />
      </main>
    );
  if (me.error || !me.data)
    return (
      <main className="uc-content">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </main>
    );
  const items = [
    { key: 'tenants', label: 'Tenants', href: '/tenants', show: me.can('platform.tenants.read') },
    { key: 'audit', label: 'Platform audit', href: '/audit', show: me.can('platform.audit.read') },
  ].filter((i) => i.show);
  return (
    <AppShell
      brand="Universal Commerce OS"
      subtitle="Platform administration"
      sections={[{ items: items.map((i) => ({ ...i, active: pathname.startsWith(i.href) })) }]}
      topbar={
        <div className="uc-row" style={{ marginLeft: 'auto' }}>
          <Badge tone="info">{me.data.platformRole?.replace('_', ' ')}</Badge>
          <span className="uc-muted">{me.data.user.email}</span>
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
  );
}
