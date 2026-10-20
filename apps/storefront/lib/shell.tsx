'use client';

import { ErrorState, LoadingState } from '@uc/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { captureVisit, useCart, useCustomer, useSite, useStore } from './shop';

const FONTS = {
  system: 'system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  sans: 'Inter, Arial, sans-serif',
} as const;
const RADIUS = { none: '0', sm: '4px', md: '8px', lg: '14px' } as const;

/** A menu or banner link: internal paths use client navigation; https links open normally. */
function MenuLink({ href, children, style }: { href: string; children: ReactNode; style?: CSSProperties }) {
  return href.startsWith('/') ? (
    <Link href={href} style={style}>
      {children}
    </Link>
  ) : (
    <a href={href} rel="noopener noreferrer" style={style}>
      {children}
    </a>
  );
}

/** Branded store frame from the published site: theme, header/footer menus, announcement banner, cart, account. */
export function Shell({ children }: { children: ReactNode }) {
  useEffect(() => captureVisit(), []);
  const store = useStore();
  const site = useSite();
  const me = useCustomer();
  const cart = useCart();
  const pathname = usePathname();
  if (store.error) return <ErrorState error={store.error} onRetry={() => void store.refetch()} />;
  if (site.error) return <ErrorState error={site.error} onRetry={() => void site.refetch()} />;
  if (!store.data || !site.data) return <LoadingState label="Loading the store" />;
  const t = site.data.theme;
  const count = cart.data?.lines.reduce((a, l) => a + l.quantity, 0) ?? 0;
  const style = {
    '--sf-primary': t.primaryColor,
    '--sf-accent': t.accentColor,
    '--uc-radius': RADIUS[t.radius],
    background: t.backgroundColor,
    color: t.textColor,
    fontFamily: FONTS[t.fontFamily],
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
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
  const banner = site.data.banner;
  return (
    <div style={style}>
      <a className="uc-skip" href="#main">
        Skip to content
      </a>
      {site.data.preview && (
        <div
          role="status"
          style={{ background: '#5b21b6', color: '#fff', padding: '6px 16px', fontWeight: 600 }}
        >
          Preview: you are seeing unpublished drafts. Shoppers see the published store.
        </div>
      )}
      {store.data.tenant.isDemo && (
        <div className="uc-demo-banner">
          Demo store — products, prices and orders here are illustrative demo data.
        </div>
      )}
      {banner && (
        <div
          role="note"
          style={{ background: t.accentColor, color: '#fff', padding: '8px 16px', textAlign: 'center' }}
        >
          {banner.linkHref ? (
            <MenuLink href={banner.linkHref} style={{ color: 'inherit', textDecoration: 'underline' }}>
              {banner.message}
            </MenuLink>
          ) : (
            banner.message
          )}
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
          <Link
            href="/"
            style={{
              color: 'inherit',
              fontSize: 20,
              fontWeight: 700,
              marginRight: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            {t.logoUrl && <img src={t.logoUrl} alt="" style={{ height: 28 }} />}
            {t.brandName}
          </Link>
          {link('/', 'Shop')}
          {site.data.menus.header.items.map((i) => (
            <MenuLink key={`${i.label}-${i.href}`} href={i.href} style={{ color: 'inherit' }}>
              {i.label}
            </MenuLink>
          ))}
          {link('/cart', count ? `Cart (${count})` : 'Cart')}
          {me.data ? link('/account', 'My account') : link('/account/login', 'Sign in')}
        </nav>
      </header>
      <main
        id="main"
        style={{ maxWidth: 1100, width: '100%', margin: '0 auto', padding: '24px 16px', flex: 1 }}
        className="uc-stack"
      >
        {children}
      </main>
      {(site.data.menus.footer.items.length > 0 || site.data.pages.length > 0) && (
        <footer style={{ borderTop: '1px solid rgba(0,0,0,0.1)', padding: '16px' }}>
          <nav
            aria-label="Footer"
            style={{ maxWidth: 1100, margin: '0 auto', display: 'flex', gap: 16, flexWrap: 'wrap' }}
          >
            {site.data.menus.footer.items.map((i) => (
              <MenuLink key={`${i.label}-${i.href}`} href={i.href} style={{ color: 'inherit' }}>
                {i.label}
              </MenuLink>
            ))}
            {site.data.pages
              .filter((p) => !site.data.menus.footer.items.some((i) => i.href === `/pages/${p.slug}`))
              .map((p) => (
                <Link key={p.slug} href={`/pages/${p.slug}`} style={{ color: 'inherit' }}>
                  {p.title}
                </Link>
              ))}
          </nav>
        </footer>
      )}
    </div>
  );
}
