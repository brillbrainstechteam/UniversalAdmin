'use client';

import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, ErrorState, LoadingState, TextField, errorMessage } from '@uc/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { buyerApi } from '../../lib/buyer';

interface Preview {
  email: string;
  companyName: string;
  storefrontName: string;
  role: string;
  userExists: boolean;
  expiresAt: string;
}

function Accept() {
  const token = useSearchParams().get('token') ?? '';
  const preview = useQuery({
    queryKey: ['invite', token],
    queryFn: () => buyerApi<Preview>('/invitations/preview', { method: 'POST', body: { token } }),
    enabled: token.length > 0,
  });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await buyerApi('/invitations/accept', {
        method: 'POST',
        body: { token, password, ...(preview.data?.userExists ? {} : { displayName: name }) },
      });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="uc-auth-page" id="main">
      <Card>
        <h1>Join your company on the buyer portal</h1>
        {!token ? (
          <Alert tone="danger">This link has no invitation token.</Alert>
        ) : preview.error ? (
          <ErrorState error={preview.error} />
        ) : !preview.data ? (
          <LoadingState rows={2} />
        ) : done ? (
          <Alert tone="success" title="You're in">
            <Link href="/login">Sign in</Link> as {preview.data.email}.
          </Alert>
        ) : (
          <form onSubmit={submit} className="uc-stack">
            <p>
              <strong>{preview.data.companyName}</strong> invited <strong>{preview.data.email}</strong> to
              order from {preview.data.storefrontName} as {preview.data.role}.
            </p>
            {!preview.data.userExists && (
              <TextField label="Your name" value={name} onChange={(e) => setName(e.target.value)} required />
            )}
            <TextField
              label={
                preview.data.userExists
                  ? 'Your current password'
                  : 'Choose a password (at least 12 characters)'
              }
              type="password"
              autoComplete={preview.data.userExists ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {error && <Alert tone="danger">{error}</Alert>}
            <Button type="submit" variant="primary" loading={busy}>
              Accept invitation
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense>
      <Accept />
    </Suspense>
  );
}
