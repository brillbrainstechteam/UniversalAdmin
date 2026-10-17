'use client';

import { useQueryClient } from '@tanstack/react-query';
import { apiRequest, Button } from '@uc/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function LogoutButton() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  async function logout() {
    setLoading(true);
    try {
      await apiRequest('/v1/auth/logout', { method: 'POST', query: { audience: 'merchant' } });
    } catch {
      // Session already invalid server-side; still clear local state.
    }
    queryClient.clear();
    router.replace('/login');
  }
  return (
    <Button size="sm" onClick={logout} loading={loading}>
      Sign out
    </Button>
  );
}
