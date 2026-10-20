'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiRequest, ApiError } from './api';
import { Alert, Button, Card, LoadingState, TextField, errorMessage } from './components';

/** Second sign-in step (Phase 11): a 6-digit authenticator code or a recovery code. */
export function MfaChallengeForm<T>({
  challengeToken,
  onSuccess,
  onRestart,
}: {
  challengeToken: string;
  onSuccess: (me: T) => void;
  onRestart: () => void;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSuccess(
        await apiRequest<T>('/v1/auth/mfa/verify', {
          method: 'POST',
          body: { challengeToken, code: code.trim().toLowerCase() },
        }),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="uc-stack" noValidate>
      <p>Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
      <TextField
        label="Verification code"
        autoComplete="one-time-code"
        inputMode="text"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        required
      />
      {error && <Alert tone="danger">{error}</Alert>}
      <Button type="submit" variant="primary" loading={busy} disabled={!code.trim()}>
        Verify
      </Button>
      <Button type="button" variant="ghost" onClick={onRestart}>
        Use a different account
      </Button>
    </form>
  );
}

/** The challenge token when a sign-in error asks for the second step. */
export function mfaChallengeOf(e: unknown): string | null {
  return e instanceof ApiError && e.code === 'MFA_REQUIRED'
    ? ((e.details as { challengeToken?: string } | undefined)?.challengeToken ?? null)
    : null;
}

interface Status {
  enrolled: boolean;
  recoveryCodesLeft: number;
}

/** Personal two-step verification settings (works for merchant staff and platform operators). */
export function MfaSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enrolment, setEnrolment] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    apiRequest<Status>('/v1/auth/mfa')
      .then(setStatus)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (!status) return error ? <Alert tone="danger">{error}</Alert> : <LoadingState rows={2} />;
  return (
    <Card title="Two-step verification">
      {recovery && (
        <Alert tone="warning" title="Save your recovery codes now">
          Each code works once if you lose your phone. They will not be shown again.
          <pre className="uc-mono" style={{ whiteSpace: 'pre-wrap' }}>
            {recovery.join('\n')}
          </pre>
        </Alert>
      )}
      {status.enrolled ? (
        <div className="uc-stack">
          <p>
            <strong>On.</strong> Sign-in asks for a code from your authenticator app. Recovery codes left:{' '}
            {status.recoveryCodesLeft}.
          </p>
          <div className="uc-form-grid">
            <TextField
              label="Your password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <TextField
              label="Current code or recovery code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <div className="uc-row">
            <Button
              variant="danger"
              loading={busy}
              disabled={!password || !code.trim()}
              onClick={() =>
                void run(async () => {
                  await apiRequest('/v1/auth/mfa/disable', {
                    method: 'POST',
                    body: { password, code: code.trim().toLowerCase() },
                  });
                  setPassword('');
                  setCode('');
                  setRecovery(null);
                  load();
                })
              }
            >
              Turn off
            </Button>
          </div>
        </div>
      ) : enrolment ? (
        <div className="uc-stack">
          <p>
            Add this account to an authenticator app (scan the link on your phone or type the key), then enter
            the code it shows.
          </p>
          <TextField label="Setup key" value={enrolment.secret} readOnly />
          <a href={enrolment.otpauthUri}>Open in authenticator app</a>
          <TextField
            label="Code from the app"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          />
          <div className="uc-row">
            <Button
              variant="primary"
              loading={busy}
              disabled={code.length !== 6}
              onClick={() =>
                void run(async () => {
                  const r = await apiRequest<{ recoveryCodes: string[] }>('/v1/auth/mfa/confirm', {
                    method: 'POST',
                    body: { code },
                  });
                  setRecovery(r.recoveryCodes);
                  setEnrolment(null);
                  setCode('');
                  load();
                })
              }
            >
              Turn on
            </Button>
          </div>
        </div>
      ) : (
        <div className="uc-stack">
          <p>
            <strong>Off.</strong> Protect your account with a code from an authenticator app at sign-in.
          </p>
          <div className="uc-row">
            <Button
              variant="primary"
              loading={busy}
              onClick={() =>
                void run(async () =>
                  setEnrolment(await apiRequest('/v1/auth/mfa/enroll', { method: 'POST' })),
                )
              }
            >
              Set up two-step verification
            </Button>
          </div>
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}
