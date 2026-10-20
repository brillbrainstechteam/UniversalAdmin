'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CustomerAddress, StorefrontOrder, StorefrontQuote } from '@uc/contracts';
import {
  Alert,
  ApiError,
  Button,
  Card,
  EmptyState,
  LoadingState,
  PageHeader,
  TextField,
  errorMessage,
  newIdempotencyKey,
} from '@uc/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { rememberOrder, shopApi, useCart, useCustomer, useMoney } from '../../lib/shop';

export default function CheckoutPage() {
  const cart = useCart();
  const me = useCustomer();
  const money = useMoney();
  const router = useRouter();
  const qc = useQueryClient();
  const saved = useQuery({
    queryKey: ['addresses'],
    queryFn: () => shopApi<{ items: CustomerAddress[] }>('/account/addresses'),
    enabled: !!me.data,
  });
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    line1: '',
    line2: '',
    city: '',
    postalCode: '',
    countryCode: '',
  });
  const [quote, setQuote] = useState<StorefrontQuote | null>(null);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => newIdempotencyKey());
  useEffect(() => {
    if (cart.data?.quote && !quote) setQuote(cart.data.quote);
  }, [cart.data, quote]);
  useEffect(() => {
    const c = me.data?.customer;
    const a = saved.data?.items.find((x) => x.isDefault)?.address;
    if (c || a)
      setForm((f) => ({
        ...f,
        name: f.name || c?.displayName || '',
        email: f.email || c?.email || '',
        phone: f.phone || c?.phone || '',
        line1: f.line1 || a?.line1 || '',
        line2: f.line2 || a?.line2 || '',
        city: f.city || a?.city || '',
        postalCode: f.postalCode || a?.postalCode || '',
        countryCode: f.countryCode || a?.countryCode || '',
      }));
  }, [me.data, saved.data]);
  if (cart.isLoading) return <LoadingState />;
  if (!cart.data || cart.data.lines.length === 0 || !quote)
    return <EmptyState title="Nothing to check out" description="Your cart is empty." />;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });
  async function place() {
    setBusy(true);
    setError(null);
    try {
      const order = await shopApi<StorefrontOrder>('/checkouts', {
        method: 'POST',
        idempotencyKey: key,
        body: {
          cartId: cart.data!.id,
          cartToken: cart.data!.token,
          quoteId: quote!.id,
          acknowledgedTotalMinor: quote!.totalMinor,
          contact: { name: form.name.trim(), email: form.email.trim(), phone: form.phone.trim() || null },
          shippingAddress: {
            line1: form.line1.trim(),
            line2: form.line2.trim() || null,
            city: form.city.trim(),
            postalCode: form.postalCode.trim() || null,
            countryCode: form.countryCode.trim().toUpperCase(),
          },
        },
      });
      rememberOrder(order.id, cart.data!.token);
      cart.clear();
      void qc.invalidateQueries({ queryKey: ['me'] });
      router.push(`/orders/${order.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PRICE_CHANGED') {
        setQuote((e.details as { quote: StorefrontQuote }).quote);
        setChanged(true);
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        title="Checkout"
        description={
          me.data ? `Signed in as ${me.data.customer.email}; this order is saved to your account.` : undefined
        }
      />
      {!me.data && (
        <Alert tone="info">
          Checking out as a guest. <Link href="/account/login?next=/checkout">Sign in</Link> to see this order
          in your account later.
        </Alert>
      )}
      <Card title="Contact">
        <div className="uc-form-grid">
          <TextField
            label="Full name"
            value={form.name}
            onChange={set('name')}
            autoComplete="name"
            required
          />
          <TextField
            label="E-mail"
            type="email"
            value={form.email}
            onChange={set('email')}
            autoComplete="email"
            required
          />
          <TextField label="Phone (optional)" value={form.phone} onChange={set('phone')} autoComplete="tel" />
        </div>
      </Card>
      <Card title="Delivery address">
        <div className="uc-form-grid">
          <TextField
            label="Address line 1"
            value={form.line1}
            onChange={set('line1')}
            autoComplete="address-line1"
            required
          />
          <TextField
            label="Address line 2 (optional)"
            value={form.line2}
            onChange={set('line2')}
            autoComplete="address-line2"
          />
          <TextField
            label="City"
            value={form.city}
            onChange={set('city')}
            autoComplete="address-level2"
            required
          />
          <TextField
            label="Postal code"
            value={form.postalCode}
            onChange={set('postalCode')}
            autoComplete="postal-code"
          />
          <TextField
            label="Country code"
            value={form.countryCode}
            onChange={set('countryCode')}
            autoComplete="country"
            hint="Two letters, e.g. GB or IN"
            required
          />
        </div>
      </Card>
      <Card title={`Total ${money(quote.totalMinor)}`}>
        {changed && (
          <Alert tone="warning" title="The price changed">
            The total is now {money(quote.totalMinor)}. Review it and place the order again to accept it.
          </Alert>
        )}
        <ul>
          {quote.lines.map((l, i) => (
            <li key={i}>
              {l.title} × {l.quantity}: {money(l.totalMinor)}
            </li>
          ))}
        </ul>
        <span className="uc-muted">
          Payment is taken on the next page through a SANDBOX gateway — no real money moves in this demo.
        </span>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button variant="primary" loading={busy} onClick={() => void place()}>
          Place order for {money(quote.totalMinor)}
        </Button>
      </Card>
    </>
  );
}
