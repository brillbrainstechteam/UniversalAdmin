'use client';

import { ErrorState, LoadingState } from '@uc/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { CSSProperties, ReactNode } from 'react';
import { useCart, useCustomer, useStore } from './shop';

const FONTS = {
  system: 'system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  sans: 'Inter, Arial, sans-serif',
} as const;

/** Branded store frame: header with the merchant's theme tokens, cart count and account link. */
export function Shell({ children }: { children: ReactNode }) {
  const store = useStore();
  const me = useCustomer();
  const cart = useCart();
  const pathname = usePathname();
  if (store.error) return <ErrorState error={store.error} onRetry={() => void store.refetch()} />;
  if (!store.data) return <LoadingState label="Loading the store" />;
  const t = store.data.theme;
  const count = cart.data?.lines.reduce((a, l) => a + l.quantity, 0) ?? 0;
  const style = {
    '--sf-primary': t.primaryColor,
    '--sf-accent': t.accentColor,
    background: t.backgroundColor,
    color: t.textColor,
    fontFamily: FONTS[t.fontFamily],
    minHeight: '100vh',
  } as CSSProperties;
  const link = (href: string, label: string) => (
    <Link
      href={href}
      aria-current={pathname === href ? 'page' : undefined}
      style={{ color: 'inherit', fontWeight: pathname === href ? 700 : 500 }}
    >
      {label}
    </Link>
  );
  return (
    <div style={style}>
      <a className="uc-skip" href="#main">
        Skip to content
      </a>
      {store.data.tenant.isDemo && (
        <div className="uc-demo-banner">
          Demo store — products, prices and orders here are illustrative demo data.
        </div>
      )}
      <header style={{ background: t.primaryColor, color: '#fff', padding: '12px 16px' }}>
        <nav
          aria-label="Store"
          style={{
            maxWidth: 1100,
            margin: '0 auto',
            display: 'flex',
            gap: 20,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <Link href="/" style={{ color: 'inherit', fontSize: 20, fontWeight: 700, marginRight: 'auto' }}>
            {t.brandName}
          </Link>
          {link('/', 'Shop')}
          {link('/cart', count ? `Cart (${count})` : 'Cart')}
          {me.data ? link('/account', 'My account') : link('/account/login', 'Sign in')}
        </nav>
      </header>
      <main id="main" style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px' }} className="uc-stack">
        {children}
      </main>
    </div>
  );
}
