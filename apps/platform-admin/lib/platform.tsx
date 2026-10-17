'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MeResponse, PlatformPermission } from '@uc/contracts';
import { apiRequest, ApiError, Button, type RequestOptions } from '@uc/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

export function useAuthRedirect(error: unknown) {
  const router = useRouter();
  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) router.replace('/login');
  }, [error, router]);
}

export function usePlatformMe() {
  const query = useQuery({
    queryKey: ['me'],
    queryFn: () => apiRequest<MeResponse>('/v1/auth/me', { query: { audience: 'platform' } }),
  });
  useAuthRedirect(query.error);
  const can = (p: PlatformPermission) => query.data?.platformPermissions.includes(p) ?? false;
  return { ...query, can };
}

export function usePlatformQuery<T>(
  key: unknown[],
  path: string,
  query?: RequestOptions['query'],
  enabled = true,
) {
  const result = useQuery({
    queryKey: ['p', ...key, query ?? {}],
    queryFn: ({ signal }) => apiRequest<T>(path, { query, signal }),
    enabled,
  });
  useAuthRedirect(result.error);
  return result;
}

export function LogoutButton() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  return (
    <Button
      size="sm"
      loading={loading}
      onClick={async () => {
        setLoading(true);
        try {
          await apiRequest('/v1/auth/logout', { method: 'POST', query: { audience: 'platform' } });
        } catch {
          /* already signed out */
        }
        queryClient.clear();
        router.replace('/login');
      }}
    >
      Sign out
    </Button>
  );
}
