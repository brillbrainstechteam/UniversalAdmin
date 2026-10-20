'use client';

import { useQueryClient } from '@tanstack/react-query';
import { LoginRequest, type MeResponse } from '@uc/contracts';
import { Alert, apiRequest, Button, Card, TextField, MfaChallengeForm, mfaChallengeOf } from '@uc/ui';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

export default function PlatformLoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [challenge, setChallenge] = useState<string | null>(null);
  const done = (me: MeResponse) => {
    queryClient.setQueryData(['me'], me);
    router.replace('/tenants');
  };

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const parsed = LoginRequest.safeParse({ email, password, audience: 'platform' });
    if (!parsed.success) return setError('Enter a valid email and password');
    setLoading(true);
    try {
      done(await apiRequest<MeResponse>('/v1/auth/login', { method: 'POST', body: parsed.data }));
    } catch (e) {
      const token = mfaChallengeOf(e);
      if (token) return setChallenge(token);
      setError(e instanceof Error ? e.message : 'Sign-in failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="uc-auth-page">
      <div className="uc-auth-card">
        <Card title="Platform operator sign-in">
          <p className="uc-muted" style={{ margin: 0 }}>
            Restricted to platform staff. All access is audited. Merchant staff should use the merchant admin.
          </p>
          {challenge ? (
            <MfaChallengeForm<MeResponse>
              challengeToken={challenge}
              onSuccess={done}
              onRestart={() => setChallenge(null)}
            />
          ) : (
            <form onSubmit={onSubmit} className="uc-stack" noValidate>
              <TextField
                label="Email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <TextField
                label="Password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {error && <Alert tone="danger">{error}</Alert>}
              <Button type="submit" variant="primary" loading={loading}>
                Sign in
              </Button>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
