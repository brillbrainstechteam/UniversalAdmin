'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTenant } from './tenant';

/** Secondary navigation under the "Companies" nav entry. */
export function CompaniesTabs() {
  const { tenantId } = useTenant();
  const pathname = usePathname();
  const base = `/t/${tenantId}/companies`;
  const tabs = [
    {
      href: base,
      label: 'Companies',
      current: pathname === base || (pathname.startsWith(`${base}/`) && !pathname.startsWith(`${base}/rfqs`)),
    },
    { href: `${base}/rfqs`, label: 'RFQ inbox', current: pathname.startsWith(`${base}/rfqs`) },
  ];
  return (
    <nav aria-label="Company sections" className="uc-row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className="uc-btn"
          data-size="sm"
          data-variant={t.current ? 'primary' : 'ghost'}
          aria-current={t.current ? 'page' : undefined}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** Exact major-unit text → integer minor units (string) for a currency with `mu` decimals; 'invalid' on bad input. */
export function toMinorText(v: string, mu: number): string | null {
  const t = v.trim().replace(/,/g, '');
  if (t === '') return null;
  const [whole, frac = '', extra] = t.split('.');
  if (
    extra !== undefined ||
    !/^\d{1,15}$/.test(whole ?? '') ||
    !/^\d*$/.test(frac) ||
    frac.length > mu ||
    (mu === 0 && t.includes('.'))
  )
    return 'invalid';
  return `${whole}${frac.padEnd(mu, '0')}`.replace(/^0+(?=\d)/, '');
}

export const RFQ_TONE: Record<string, 'success' | 'warning' | 'info' | undefined> = {
  submitted: 'warning',
  quoted: 'info',
  accepted: 'success',
};
