'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, PageHeader, TextField, errorMessage } from '@uc/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { safeNext, shopApi } from '../../../lib/shop';

function Register() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [form, setForm] = useState({ displayName: '', email: '', phone: '', password: '' });
  const [marketing, setMarketing] = useState({ email: false, sms: false, whatsapp: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await shopApi('/account/register', {
        method: 'POST',
        body: { ...form, phone: form.phone.trim() || null, marketing },
      });
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
      <PageHeader
        title="Create an account"
        description="See your orders, track shipments and request returns."
      />
      <Card>
        <form onSubmit={(e) => void submit(e)} className="uc-stack" style={{ maxWidth: 460 }}>
          <TextField
            label="Full name"
            autoComplete="name"
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            required
          />
          <TextField
            label="E-mail"
            type="email"
            autoComplete="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            required
          />
          <TextField
            label="Phone (optional)"
            autoComplete="tel"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
          <TextField
            label="Password"
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            hint="At least 12 characters"
            required
          />
          <fieldset style={{ border: 0, padding: 0 }}>
            <legend className="uc-label">Marketing messages (optional)</legend>
            <Checkbox
              label="E-mail me offers and news"
              checked={marketing.email}
              onChange={(e) => setMarketing({ ...marketing, email: e.target.checked })}
            />
            <Checkbox
              label="Send offers by SMS"
              checked={marketing.sms}
              onChange={(e) => setMarketing({ ...marketing, sms: e.target.checked })}
            />
            <Checkbox
              label="Send offers on WhatsApp"
              checked={marketing.whatsapp}
              onChange={(e) => setMarketing({ ...marketing, whatsapp: e.target.checked })}
            />
            <span className="uc-hint">
              You can change these any time in your account. Order updates are not marketing.
            </span>
          </fieldset>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" variant="primary" loading={busy}>
            Create account
          </Button>
          <span>
            Already have an account? <Link href="/account/login">Sign in</Link>
          </span>
        </form>
      </Card>
    </>
  );
}

export default function RegisterPage() {
  return (
    <Suspense>
      <Register />
    </Suspense>
  );
}
