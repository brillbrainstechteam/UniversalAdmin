'use client';

import { useQuery } from '@tanstack/react-query';
import { formatMinor, currencyMinorUnits, type BuyerContext } from '@uc/contracts';
import { ApiError, apiRequest, type RequestOptions } from '@uc/ui';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

const COMPANY_KEY = 'uc_buyer_company';

function storedCompany(): string | null {
  try {
    return window.localStorage.getItem(COMPANY_KEY);
  } catch {
    return null;
  }
}

/** Buyer API call: same-origin proxy, CSRF header, chosen company. */
export function buyerApi<T>(path: string, options: Omit<RequestOptions, 'tenantId'> = {}): Promise<T> {
  const company = typeof window !== 'undefined' ? storedCompany() : null;
  return apiRequest<T>(`/v1/storefront/b2b${path}`, {
    ...options,
    headers: { ...(company ? { 'X-Company-Id': company } : {}), ...(options.headers ?? {}) },
  });
}

interface Ctx {
  me: BuyerContext;
  switchCompany: (id: string) => void;
  money: (amountMinor: string) => string;
}
const BuyerCtx = createContext<Ctx | null>(null);

export function useBuyer(): Ctx {
  const v = useContext(BuyerCtx);
  if (!v) throw new Error('useBuyer must be used inside BuyerProvider');
  return v;
}

/** Loads the buyer context; signed-out users go to /login. */
export function BuyerProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const router = useRouter();
  const [version, setVersion] = useState(0);
  const q = useQuery({ queryKey: ['me', version], queryFn: () => buyerApi<BuyerContext>('/me') });
  useEffect(() => {
    if (q.error instanceof ApiError && (q.error.status === 401 || q.error.status === 403))
      router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
    if (q.error instanceof ApiError && q.error.status === 404 && storedCompany()) {
      // A remembered company the buyer no longer belongs to: forget it and reload.
      try {
        window.localStorage.removeItem(COMPANY_KEY);
      } catch {
        /* ignore */
      }
      setVersion((v) => v + 1);
    }
  }, [q.error, router]);
  const switchCompany = useCallback((id: string) => {
    try {
      window.localStorage.setItem(COMPANY_KEY, id);
    } catch {
      /* ignore */
    }
    window.location.assign('/');
  }, []);
  if (!q.data) return <>{fallback}</>;
  const currency = q.data.storefront.currency;
  const mu = currencyMinorUnits(currency);
  const money = (amountMinor: string) => {
    const neg = amountMinor.startsWith('-');
    const text = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: mu,
    }).format(formatMinor(amountMinor.replace('-', ''), mu) as unknown as number);
    return neg ? `−${text}` : text;
  };
  return <BuyerCtx.Provider value={{ me: q.data, switchCompany, money }}>{children}</BuyerCtx.Provider>;
}

export const STATUS_LABELS: Record<string, string> = {
  awaiting_buyer_approval: 'Waiting for your company approver',
  awaiting_approval: 'Waiting for supplier approval',
  pending_payment: 'Waiting for payment',
  confirmed: 'Confirmed',
  on_hold: 'On hold',
  cancelled: 'Cancelled',
};
