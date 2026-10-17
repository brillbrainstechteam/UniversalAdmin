'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Password, type InvitationPreviewResponse } from '@uc/contracts';
import { Alert, apiRequest, Button, Card, ErrorState, LoadingState, TextField, formatDateTime } from '@uc/ui';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';

/** Token is read from the URL fragment, which browsers never send to servers (ADR-010). */
function useInviteToken(): string | null | undefined {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const match = /token=([A-Za-z0-9_-]+)/.exec(window.location.hash);
    setToken(match?.[1] ?? null);
  }, []);
  return token;
}

export default function AcceptInvitePage() {
  const token = useInviteToken();
  const preview = useQuery({
    queryKey: ['invite-preview', token],
    queryFn: () =>
      apiRequest<InvitationPreviewResponse>('/v1/auth/invitations/preview', {
        method: 'POST',
        body: { token },
      }),
    enabled: Boolean(token),
    retry: false,
  });
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const accept = useMutation({
    mutationFn: () =>
      apiRequest<{ accountCreated: boolean }>('/v1/auth/invitations/accept', {
        method: 'POST',
        body: { token, password, displayName: displayName || undefined },
      }),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    if (preview.data && !preview.data.userExists) {
      if (!displayName.trim()) return setFormError('Enter your name');
      const policy = Password.safeParse(password);
      if (!policy.success) return setFormError(policy.error.issues[0]?.message ?? 'Invalid password');
      if (password !== confirm) return setFormError('Passwords do not match');
    }
    accept.mutate();
  }

  return (
    <div className="uc-auth-page">
      <div className="uc-auth-card">
        <Card title="Accept invitation">
          {token === undefined || (token && preview.isLoading) ? (
            <LoadingState rows={3} />
          ) : !token ? (
            <Alert tone="danger" title="Invitation link is incomplete">
              Open the full link you were given. It contains a token after the # sign.
            </Alert>
          ) : preview.error ? (
            <ErrorState error={preview.error} />
          ) : accept.isSuccess ? (
            <div className="uc-stack">
              <Alert tone="success" title="You’re in">
                {accept.data.accountCreated
                  ? 'Your account was created.'
                  : 'The merchant was added to your account.'}
              </Alert>
              <Link className="uc-btn" data-variant="primary" href="/login">
                Continue to sign in
              </Link>
            </div>
          ) : preview.data ? (
            <form className="uc-stack" onSubmit={onSubmit} noValidate>
              <p>
                <strong>{preview.data.tenantName}</strong> invited <strong>{preview.data.email}</strong> as{' '}
                {preview.data.roles.join(', ')}. Expires {formatDateTime(preview.data.expiresAt)}.
              </p>
              {preview.data.userExists ? (
                <TextField
                  label="Your current password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  hint="This email already has an account; confirm it to join."
                />
              ) : (
                <>
                  <TextField
                    label="Your name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    autoComplete="name"
                  />
                  <TextField
                    label="Choose a password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    hint="At least 12 characters"
                  />
                  <TextField
                    label="Confirm password"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </>
              )}
              {(formError || accept.error) && (
                <Alert tone="danger">{formError ?? (accept.error as Error).message}</Alert>
              )}
              <Button type="submit" variant="primary" loading={accept.isPending}>
                Accept invitation
              </Button>
            </form>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
