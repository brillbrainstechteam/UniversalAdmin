'use client';

import { apiRequest, Card, ErrorState, LoadingState } from '@uc/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/**
 * Phase 12: platform support lands here with a one-time code in the URL fragment (never sent to servers or logs).
 * Redeeming it on this origin opens a read-only support session for the approved merchant.
 */
export default function SupportStartPage() {
  const router = useRouter();
  const [error, setError] = useState<unknown>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const code = new URLSearchParams(window.location.hash.slice(1)).get('code');
    window.history.replaceState(null, '', window.location.pathname);
    if (!code) {
      setError(
        new Error('This support link is incomplete. Start the session again from the platform console.'),
      );
      return;
    }
    apiRequest<{ tenantId: string }>('/v1/auth/support/redeem', { method: 'POST', body: { code } })
      .then((r) => router.replace(`/t/${r.tenantId}`))
      .catch(setError);
  }, [router]);
  return (
    <main className="uc-content" style={{ maxWidth: 640, margin: '0 auto' }}>
      {error ? (
        <Card title="Could not start the support session">
          <ErrorState error={error} />
          <Link href="/login">Go to sign in</Link>
        </Card>
      ) : (
        <LoadingState label="Opening read-only support session" />
      )}
    </main>
  );
}
