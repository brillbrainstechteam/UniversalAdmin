'use client';

import { Alert, Button, Card, TextField, errorMessage } from '@uc/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { buyerApi } from '../../lib/buyer';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await buyerApi('/auth/login', { method: 'POST', body: { email, password } });
      const next = params.get('next');
      router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="uc-auth-page" id="main">
      <Card>
        <h1>Buyer portal sign-in</h1>
        <form onSubmit={submit} className="uc-stack">
          <TextField
            label="Email"
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
        </form>
        <p className="uc-muted">Accounts are created by invitation from your supplier.</p>
      </Card>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
