'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  currencyMinorUnits,
  formatMinor,
  type Cart,
  type CustomerMe,
  type QuoteLineInput,
  type StorefrontConfig,
} from '@uc/contracts';
import { ApiError, apiRequest, type RequestOptions } from '@uc/ui';
import { useCallback } from 'react';

/** Storefront API call through the same-origin proxy (the proxy adds the store domain and gateway key). */
export function shopApi<T>(path: string, options: Omit<RequestOptions, 'tenantId'> = {}): Promise<T> {
  return apiRequest<T>(`/v1/storefront${path}`, options);
}

/** Only same-site relative paths are followed after sign-in. */
export function safeNext(v: string | null): string {
  return v && v.startsWith('/') && !v.startsWith('//') ? v : '/account';
}

export function useStore() {
  return useQuery({
    queryKey: ['config'],
    queryFn: () => shopApi<StorefrontConfig>('/config'),
    staleTime: 300_000,
  });
}

/** Signed-in customer, or null for guests. */
export function useCustomer() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await shopApi<CustomerMe>('/account/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
  });
}

export function useMoney() {
  const store = useStore();
  const currency = store.data?.currency ?? 'USD';
  const mu = currencyMinorUnits(currency);
  return (amountMinor: string) =>
    new Intl.NumberFormat(store.data?.locale ?? undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: mu,
    }).format(formatMinor(amountMinor, mu) as unknown as number);
}

// ---------------------------------------------------------------- cart (id + token kept in this browser)

const CART_KEY = 'uc_cart';
type CartRef = { cartId: string; cartToken: string };

function readCart(): CartRef | null {
  try {
    const v = window.localStorage.getItem(CART_KEY);
    return v ? (JSON.parse(v) as CartRef) : null;
  } catch {
    return null;
  }
}
function writeCart(v: CartRef | null) {
  try {
    if (v) window.localStorage.setItem(CART_KEY, JSON.stringify(v));
    else window.localStorage.removeItem(CART_KEY);
  } catch {
    /* storage unavailable: the cart lives only for this page */
  }
}

/** Remembers the cart token for an order so its status page can be opened again from this browser. */
export function rememberOrder(orderId: string, cartToken: string) {
  try {
    window.localStorage.setItem(`uc_order_${orderId}`, cartToken);
  } catch {
    /* ignore */
  }
}
export function orderToken(orderId: string): string | null {
  try {
    return window.localStorage.getItem(`uc_order_${orderId}`);
  } catch {
    return null;
  }
}

export function useCart() {
  const qc = useQueryClient();
  const cart = useQuery({
    queryKey: ['cart'],
    queryFn: async () => {
      const ref = readCart();
      if (!ref) return null;
      try {
        const c = await shopApi<Cart>(`/carts/${ref.cartId}`, { headers: { 'X-Cart-Token': ref.cartToken } });
        if (c.status !== 'open') {
          writeCart(null);
          return null;
        }
        return { ...c, token: ref.cartToken };
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          writeCart(null);
          return null;
        }
        throw e;
      }
    },
  });
  /** Replaces the cart lines (server re-prices them); creates the cart on first use. */
  const setLines = useCallback(
    async (lines: QuoteLineInput[]) => {
      let ref = readCart();
      if (!ref) {
        ref = await shopApi<CartRef>('/carts', { method: 'POST' });
        writeCart(ref);
      }
      const c = await shopApi<Cart>(`/carts/${ref.cartId}/lines`, {
        method: 'PUT',
        body: { lines },
        headers: { 'X-Cart-Token': ref.cartToken },
      });
      qc.setQueryData(['cart'], { ...c, token: ref.cartToken });
      return c;
    },
    [qc],
  );
  const clear = useCallback(() => {
    writeCart(null);
    qc.setQueryData(['cart'], null);
  }, [qc]);
  return { ...cart, setLines, clear };
}
