'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CustomerAddress, CustomerMe, Page } from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  TextField,
  errorMessage,
  formatDateTime,
  useCursorPagination,
  useToast,
} from '@uc/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { shopApi, useCustomer, useMoney } from '../../lib/shop';

interface OrderRow {
  id: string;
  number: string;
  status: string;
  fulfillmentStatus: string;
  totalMinor: string;
  createdAt: string;
}

const STATUS: Record<string, string> = {
  pending_payment: 'Awaiting payment',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  on_hold: 'On hold',
};

export default function AccountPage() {
  const me = useCustomer();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const money = useMoney();
  const pager = useCursorPagination('');
  useEffect(() => {
    if (me.data === null) router.replace('/account/login?next=/account');
  }, [me.data, router]);
  const orders = useQuery({
    queryKey: ['my-orders', pager.cursor],
    queryFn: () =>
      shopApi<Page<OrderRow>>('/account/orders', { query: { limit: 10, cursor: pager.cursor ?? undefined } }),
    enabled: !!me.data,
  });
  const addresses = useQuery({
    queryKey: ['addresses'],
    queryFn: () => shopApi<{ items: CustomerAddress[] }>('/account/addresses'),
    enabled: !!me.data,
  });
  const [addr, setAddr] = useState({ label: '', line1: '', city: '', postalCode: '', countryCode: '' });
  const prefs = useMutation({
    mutationFn: (p: Partial<CustomerMe['preferences']>) =>
      shopApi<CustomerMe>('/account/preferences', { method: 'PUT', body: p }),
    onSuccess: (m) => {
      qc.setQueryData(['me'], m);
      toast('Preferences saved');
    },
  });
  const addAddress = useMutation({
    mutationFn: () =>
      shopApi<{ items: CustomerAddress[] }>('/account/addresses', {
        method: 'POST',
        body: {
          label: addr.label.trim() || null,
          address: {
            line1: addr.line1.trim(),
            city: addr.city.trim(),
            postalCode: addr.postalCode.trim() || null,
            countryCode: addr.countryCode.trim().toUpperCase(),
          },
        },
      }),
    onSuccess: (r) => {
      qc.setQueryData(['addresses'], r);
      setAddr({ label: '', line1: '', city: '', postalCode: '', countryCode: '' });
      toast('Address saved');
    },
  });
  const removeAddress = useMutation({
    mutationFn: (id: string) =>
      shopApi<{ items: CustomerAddress[] }>(`/account/addresses/${id}`, { method: 'DELETE' }),
    onSuccess: (r) => qc.setQueryData(['addresses'], r),
  });
  const logout = useMutation({
    mutationFn: () => shopApi('/account/logout', { method: 'POST' }),
    onSuccess: () => {
      qc.setQueryData(['me'], null);
      router.push('/');
    },
  });
  if (me.error) return <ErrorState error={me.error} onRetry={() => void me.refetch()} />;
  if (!me.data) return <LoadingState />;
  const c = me.data.customer;
  const p = me.data.preferences;
  return (
    <>
      <PageHeader
        title={`Hello, ${c.displayName}`}
        description={c.email}
        actions={
          <Button onClick={() => logout.mutate()} loading={logout.isPending}>
            Sign out
          </Button>
        }
      />
      {!c.emailVerified && (
        <Alert tone="info">
          Your e-mail address is not verified yet (e-mail delivery is not set up for this store).
        </Alert>
      )}
      <Card title="Your orders">
        <DataTable
          caption="Your orders"
          rows={orders.data?.items}
          isLoading={orders.isLoading}
          error={orders.error}
          rowKey={(o) => o.id}
          pagination={pager.controls(orders.data?.nextCursor)}
          empty={
            <EmptyState title="No orders yet" description="Orders you place while signed in appear here." />
          }
          columns={[
            {
              key: 'n',
              header: 'Order',
              render: (o) => <Link href={`/account/orders/${o.id}`}>{o.number}</Link>,
            },
            { key: 'd', header: 'Placed', render: (o) => formatDateTime(o.createdAt) },
            {
              key: 's',
              header: 'Status',
              render: (o) => (
                <>
                  <Badge>{STATUS[o.status] ?? o.status}</Badge>{' '}
                  {o.status === 'confirmed' && (
                    <Badge>
                      {o.fulfillmentStatus === 'fulfilled'
                        ? 'Shipped'
                        : o.fulfillmentStatus === 'partial'
                          ? 'Partly shipped'
                          : 'Preparing'}
                    </Badge>
                  )}
                </>
              ),
            },
            {
              key: 't',
              header: 'Total',
              render: (o) => <span className="uc-mono">{money(o.totalMinor)}</span>,
            },
          ]}
        />
      </Card>
      <Card title="Marketing preferences">
        <Checkbox
          label="E-mail offers and news"
          checked={p.email}
          onChange={(e) => prefs.mutate({ email: e.target.checked })}
        />
        <Checkbox
          label="SMS offers"
          checked={p.sms}
          onChange={(e) => prefs.mutate({ sms: e.target.checked })}
        />
        <Checkbox
          label="WhatsApp offers"
          checked={p.whatsapp}
          onChange={(e) => prefs.mutate({ whatsapp: e.target.checked })}
        />
        <span className="uc-hint">
          Every change is recorded with its time. Order updates are sent regardless of these choices.
        </span>
        {prefs.error && <Alert tone="danger">{errorMessage(prefs.error)}</Alert>}
      </Card>
      <Card title="Saved addresses">
        {addresses.data && addresses.data.items.length === 0 && <EmptyState title="No saved addresses" />}
        <ul className="uc-stack">
          {addresses.data?.items.map((a) => (
            <li key={a.id} className="uc-row">
              <span>
                {a.label && <strong>{a.label}: </strong>}
                {a.address.line1}, {a.address.city} {a.address.countryCode}{' '}
                {a.isDefault && <Badge>default</Badge>}
              </span>
              <Button size="sm" onClick={() => removeAddress.mutate(a.id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <div className="uc-form-grid">
          <TextField
            label="Label (optional)"
            value={addr.label}
            onChange={(e) => setAddr({ ...addr, label: e.target.value })}
          />
          <TextField
            label="Address line 1"
            value={addr.line1}
            onChange={(e) => setAddr({ ...addr, line1: e.target.value })}
          />
          <TextField
            label="City"
            value={addr.city}
            onChange={(e) => setAddr({ ...addr, city: e.target.value })}
          />
          <TextField
            label="Postal code"
            value={addr.postalCode}
            onChange={(e) => setAddr({ ...addr, postalCode: e.target.value })}
          />
          <TextField
            label="Country code"
            value={addr.countryCode}
            onChange={(e) => setAddr({ ...addr, countryCode: e.target.value })}
            hint="e.g. GB or IN"
          />
        </div>
        {addAddress.error && <Alert tone="danger">{errorMessage(addAddress.error)}</Alert>}
        <div className="uc-row">
          <Button
            disabled={!addr.line1.trim() || !addr.city.trim() || addr.countryCode.trim().length !== 2}
            loading={addAddress.isPending}
            onClick={() => addAddress.mutate()}
          >
            Save address
          </Button>
        </div>
      </Card>
    </>
  );
}
