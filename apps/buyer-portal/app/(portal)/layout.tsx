'use client';

import { AppShell, Badge, Button, LoadingState, SelectField } from '@uc/ui';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { BuyerProvider, buyerApi, useBuyer } from '../../lib/buyer';

function Shell({ children }: { children: ReactNode }) {
  const { me, switchCompany } = useBuyer();
  const pathname = usePathname();
  const router = useRouter();
  const approver = me.company && me.company.role !== 'buyer';
  const items = [
    { key: 'home', label: 'Home', href: '/' },
    { key: 'catalog', label: 'Catalog', href: '/catalog' },
    { key: 'order', label: 'Quick order', href: '/order' },
    { key: 'orders', label: 'Orders', href: '/orders' },
    ...(approver ? [{ key: 'approvals', label: 'Approvals', href: '/approvals' }] : []),
    { key: 'rfqs', label: 'Requests for quote', href: '/rfqs' },
    { key: 'quotations', label: 'Quotations', href: '/quotations' },
  ].map((i) => ({ ...i, active: i.href === '/' ? pathname === '/' : pathname.startsWith(i.href) }));
  async function signOut() {
    try {
      await buyerApi('/auth/logout', { method: 'POST' });
    } finally {
      router.replace('/login');
    }
  }
  return (
    <AppShell
      brand={me.storefront.name}
      subtitle="Buyer portal"
      sections={[{ items }]}
      banner={
        me.storefront.isDemo ? (
          <div className="uc-demo-banner">Demo merchant — all data here is illustrative demo data.</div>
        ) : undefined
      }
      topbar={
        <div className="uc-row" style={{ marginLeft: 'auto', flexWrap: 'wrap' }}>
          {me.companies.length > 1 ? (
            <SelectField
              label="Company"
              value={me.company?.id ?? ''}
              onChange={(e) => switchCompany(e.target.value)}
              options={me.companies.map((c) => ({ value: c.id, label: c.name }))}
            />
          ) : (
            <strong>{me.company?.name}</strong>
          )}
          {me.company && <Badge>{me.company.role}</Badge>}
          <span className="uc-muted">{me.user.email}</span>
          <Button size="sm" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      }
      renderLink={({ href, children: label, active, onClick }) => (
        <Link href={href} aria-current={active ? 'page' : undefined} onClick={onClick}>
          {label}
        </Link>
      )}
    >
      {children}
    </AppShell>
  );
}

export default function PortalLayout({ children }: { children: ReactNode }) {
  return (
    <BuyerProvider
      fallback={
        <main className="uc-content">
          <LoadingState label="Loading your company" />
        </main>
      }
    >
      <Shell>{children}</Shell>
    </BuyerProvider>
  );
}
