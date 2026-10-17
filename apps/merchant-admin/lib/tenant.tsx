'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminContext, MeResponse, TenantPermission } from '@uc/contracts';
import { apiRequest, ApiError, type RequestOptions } from '@uc/ui';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react';

/** Redirects to /login when the API reports the session is gone. */
export function useAuthRedirect(error: unknown) {
  const router = useRouter();
  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) {
      router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
    }
  }, [error, router]);
}

export function useMe() {
  const query = useQuery({
    queryKey: ['me'],
    queryFn: () => apiRequest<MeResponse>('/v1/auth/me', { query: { audience: 'merchant' } }),
  });
  useAuthRedirect(query.error);
  return query;
}

interface TenantContextValue {
  tenantId: string;
  context: AdminContext;
  can: (permission: TenantPermission) => boolean;
  api: <T>(path: string, options?: Omit<RequestOptions, 'tenantId'>) => Promise<T>;
}

const TenantCtx = createContext<TenantContextValue | null>(null);

export function TenantProvider({
  tenantId,
  context,
  children,
}: {
  tenantId: string;
  context: AdminContext;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const api = useCallback(
    async <T,>(path: string, options: Omit<RequestOptions, 'tenantId'> = {}) => {
      try {
        return await apiRequest<T>(path, { ...options, tenantId });
      } catch (error) {
        // Membership/tenant state changed server-side: refresh the context so the shell reflects it.
        if (error instanceof ApiError && ['TENANT_ACCESS_DENIED', 'TENANT_SUSPENDED'].includes(error.code)) {
          void queryClient.invalidateQueries({ queryKey: ['context', tenantId] });
        }
        throw error;
      }
    },
    [tenantId, queryClient],
  );
  const can = useCallback((p: TenantPermission) => context.permissions.includes(p), [context.permissions]);
  return <TenantCtx.Provider value={{ tenantId, context, can, api }}>{children}</TenantCtx.Provider>;
}

export function useTenant(): TenantContextValue {
  const value = useContext(TenantCtx);
  if (!value) throw new Error('useTenant must be used inside TenantProvider');
  return value;
}

/** Tenant-scoped query key helper so caches never mix tenants. */
export function useTenantQuery<T>(
  key: unknown[],
  path: string,
  query?: RequestOptions['query'],
  enabled = true,
) {
  const { tenantId, api } = useTenant();
  const result = useQuery({
    queryKey: ['t', tenantId, ...key, query ?? {}],
    queryFn: ({ signal }) => api<T>(path, { query, signal }),
    enabled,
  });
  useAuthRedirect(result.error);
  return result;
}
