'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StorefrontOrder } from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  errorMessage,
  formatDateTime,
} from '@uc/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { orderToken, shopApi, useCustomer, useMoney } from '../../../lib/shop';

const LABELS: Record<string, string> = {
  pending_payment: 'Waiting for payment',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  on_hold: 'On hold — the store will contact you',
  unfulfilled: 'Not shipped yet',
  partial: 'Partly shipped',
  fulfilled: 'Shipped',
};

export default function OrderStatusPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const money = useMoney();
  const me = useCustomer();
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => setToken(orderToken(orderId)), [orderId]);
  const order = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => shopApi<StorefrontOrder>(`/orders/${orderId}`, { headers: { 'X-Cart-Token': token! } }),
    enabled: !!token,
  });
  const pay = useMutation({
    mutationFn: (outcome: 'succeeded' | 'failed') =>
      shopApi<StorefrontOrder>(`/orders/${orderId}/sandbox-payment`, {
        method: 'POST',
        body: { cartToken: token, outcome },
      }),
    onSuccess: (o) => {
      qc.setQueryData(['order', orderId], o);
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  if (token === undefined) return <LoadingState />;
  if (!token)
    return (
      <EmptyState
        title="Order not available in this browser"
        description={me.data ? 'Open it from your account.' : 'Sign in to see orders saved to your account.'}
      />
    );
  if (order.error) return <ErrorState error={order.error} onRetry={() => void order.refetch()} />;
  if (!order.data) return <LoadingState />;
  const o = order.data;
  const payable = o.status === 'pending_payment' && (!o.expiresAt || new Date(o.expiresAt) > new Date());
  return (
    <>
      <PageHeader title={`Order ${o.number}`} description={`Placed ${formatDateTime(o.createdAt)}`} />
      <div className="uc-row">
        <Badge tone={o.status === 'confirmed' ? 'success' : o.status === 'cancelled' ? undefined : 'warning'}>
          {LABELS[o.status] ?? o.status}
        </Badge>
        {o.status === 'confirmed' && <Badge>{LABELS[o.fulfillmentStatus]}</Badge>}
      </div>
      {payable && (
        <Card title={`Pay ${money(o.totalMinor)}`}>
          <Alert tone="warning" title="Sandbox payment">
            This store runs a test gateway: no card is charged and no money moves. Choose the outcome to
            simulate.
          </Alert>
          {o.expiresAt && (
            <span className="uc-muted">Your items are held until {formatDateTime(o.expiresAt)}.</span>
          )}
          {pay.error && <Alert tone="danger">{errorMessage(pay.error)}</Alert>}
          <div className="uc-row">
            <Button
              variant="primary"
              loading={pay.isPending && pay.variables === 'succeeded'}
              onClick={() => pay.mutate('succeeded')}
            >
              Pay (sandbox)
            </Button>
            <Button
              loading={pay.isPending && pay.variables === 'failed'}
              onClick={() => pay.mutate('failed')}
            >
              Simulate a declined payment
            </Button>
          </div>
          {o.payment?.status === 'failed' && (
            <Alert tone="danger">
              The payment was declined. You can try again while your items are held.
            </Alert>
          )}
        </Card>
      )}
      {o.status === 'confirmed' && (
        <Alert tone="success">Thank you — payment received and your order is confirmed.</Alert>
      )}
      <Card title={`Total ${money(o.totalMinor)}`}>
        <ul>
          {o.lines.map((l, i) => (
            <li key={i}>
              {l.title} × {l.quantity}: {money(l.totalMinor)}
            </li>
          ))}
        </ul>
        {me.data && <Link href={`/account/orders/${o.id}`}>Track this order in your account</Link>}
      </Card>
    </>
  );
}
