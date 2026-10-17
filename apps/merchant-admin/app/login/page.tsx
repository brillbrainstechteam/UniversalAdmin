'use client';

import { useQueryClient } from '@tanstack/react-query';
import { LoginRequest, type MeResponse } from '@uc/contracts';
import { Alert, apiRequest, ApiError, Button, Card, TextField } from '@uc/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const parsed = LoginRequest.safeParse({ email, password, audience: 'merchant' });
    if (!parsed.success) {
      setFieldErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    setFieldErrors({});
    setLoading(true);
    try {
      const me = await apiRequest<MeResponse>('/v1/auth/login', { method: 'POST', body: parsed.data });
      queryClient.setQueryData(['me'], me);
      const next = params.get('next');
      // Only follow same-app relative paths (no open redirect).
      router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === 'ACCOUNT_LOCKED'
          ? 'Too many failed attempts. This account is locked for 15 minutes.'
          : e instanceof Error
            ? e.message
            : 'Sign-in failed',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="uc-auth-page">
      <div className="uc-auth-card">
        <Card title="Sign in to your merchant admin">
          <form onSubmit={onSubmit} className="uc-stack" noValidate>
            <TextField
              label="Email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={fieldErrors.email}
              required
            />
            <TextField
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={fieldErrors.password}
              required
            />
            {error && <Alert tone="danger">{error}</Alert>}
            <Button type="submit" variant="primary" loading={loading}>
              Sign in
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
