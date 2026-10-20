'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, PageHeader, TextField, errorMessage } from '@uc/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { safeNext, shopApi } from '../../../lib/shop';

function Login() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await shopApi('/account/login', { method: 'POST', body: { email, password } });
      await qc.invalidateQueries({ queryKey: ['me'] });
      router.push(safeNext(params.get('next')));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader title="Sign in" />
      <Card>
        <form onSubmit={(e) => void submit(e)} className="uc-stack" style={{ maxWidth: 420 }}>
          <TextField
            label="E-mail"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <TextField
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" variant="primary" loading={busy}>
            Sign in
          </Button>
          <span>
            New here?{' '}
            <Link
              href={`/account/register${params.get('next') ? `?next=${encodeURIComponent(params.get('next')!)}` : ''}`}
            >
              Create an account
            </Link>
          </span>
          <span className="uc-muted">
            Password reset by e-mail is not available yet (no e-mail service is connected).
          </span>
        </form>
      </Card>
    </>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}
