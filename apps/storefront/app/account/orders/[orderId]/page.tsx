'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CustomerOrder } from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  ErrorState,
  LoadingState,
  PageHeader,
  TextField,
  errorMessage,
  formatDateTime,
} from '@uc/ui';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError } from '@uc/ui';
import { shopApi, useMoney } from '../../../../lib/shop';

const RETURN_LABELS: Record<string, string> = {
  requested: 'Requested',
  approved: 'Approved — send the items back',
  rejected: 'Not approved',
  received: 'Received',
};

export default function AccountOrderPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const router = useRouter();
  const money = useMoney();
  const qc = useQueryClient();
  const order = useQuery({
    queryKey: ['my-order', orderId],
    queryFn: () => shopApi<CustomerOrder>(`/account/orders/${orderId}`),
  });
  const [qty, setQty] = useState<Record<number, string>>({});
  const [reason, setReason] = useState('');
  const request = useMutation({
    mutationFn: () =>
      shopApi<CustomerOrder>(`/account/orders/${orderId}/returns`, {
        method: 'POST',
        body: {
          reason: reason.trim(),
          lines: Object.entries(qty)
            .map(([lineNo, q]) => ({
              lineNo: Number.parseInt(lineNo, 10),
              quantity: Number.parseInt(q || '0', 10),
            }))
            .filter((l) => l.quantity > 0),
        },
      }),
    onSuccess: (o) => {
      qc.setQueryData(['my-order', orderId], o);
      setQty({});
      setReason('');
    },
  });
  if (order.error instanceof ApiError && order.error.status === 401) {
    router.replace(`/account/login?next=/account/orders/${orderId}`);
    return <LoadingState />;
  }
  if (order.error) return <ErrorState error={order.error} onRetry={() => void order.refetch()} />;
  if (!order.data) return <LoadingState />;
  const o = order.data;
  const returnable = o.lines.filter((l) => l.returnableQuantity > 0);
  const windowOpen = o.returnDeadline !== null && new Date(o.returnDeadline) > new Date();
  return (
    <>
      <PageHeader
        title={`Order ${o.number}`}
        description={`Placed ${formatDateTime(o.createdAt)} · total ${money(o.totalMinor)}`}
      />
      <div className="uc-row">
        <Badge>{o.status.replace(/_/g, ' ')}</Badge>
        <Badge>{o.paymentStatus.replace(/_/g, ' ')}</Badge>
        <Badge>
          {o.fulfillmentStatus === 'fulfilled'
            ? 'shipped'
            : o.fulfillmentStatus === 'partial'
              ? 'partly shipped'
              : 'not shipped yet'}
        </Badge>
      </div>
      <Card title="Items">
        <ul>
          {o.lines.map((l) => (
            <li key={l.lineNo}>
              {l.title}
              {l.serialTag ? ` (${l.serialTag})` : ''} × {l.quantity}: {money(l.totalMinor)} · shipped{' '}
              {l.shippedQuantity}
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Shipments">
        {o.shipments.length === 0 ? (
          <span className="uc-muted">Nothing has shipped yet.</span>
        ) : (
          <ul className="uc-stack">
            {o.shipments.map((s) => (
              <li key={s.number}>
                <strong>{s.number}</strong> · {s.status === 'delivered' ? 'Delivered' : 'On its way'}
                {s.carrier && ` · ${s.carrier}`}
                {s.trackingNumber && ` · tracking number ${s.trackingNumber}`}
                {s.shippedAt && ` · shipped ${formatDateTime(s.shippedAt)}`}
                <div className="uc-hint">
                  Tracking details are provided by the store; use the carrier&apos;s own website to follow the
                  parcel.
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {(o.returns.length > 0 || returnable.length > 0) && (
        <Card title="Returns">
          {o.returns.map((r) => (
            <p key={r.id}>
              <strong>{r.number}</strong> · {RETURN_LABELS[r.status] ?? r.status} · {money(r.valueMinor)} ·{' '}
              {r.reason}
              {r.decisionNote && <span className="uc-muted"> — {r.decisionNote}</span>}
            </p>
          ))}
          {o.refunds.map((r, i) => (
            <p key={i}>
              Refund {money(r.amountMinor)}: {r.status === 'succeeded' ? 'refunded' : r.status}
            </p>
          ))}
          {returnable.length > 0 && windowOpen && (
            <div className="uc-stack">
              <strong>Request a return</strong>
              <span className="uc-muted">
                You can request a return until {formatDateTime(o.returnDeadline!)}.
              </span>
              <div className="uc-form-grid">
                {returnable.map((l) => (
                  <TextField
                    key={l.lineNo}
                    label={`${l.title}${l.serialTag ? ` (${l.serialTag})` : ''} — up to ${l.returnableQuantity}`}
                    inputMode="numeric"
                    value={qty[l.lineNo] ?? ''}
                    onChange={(e) => setQty({ ...qty, [l.lineNo]: e.target.value.replace(/\D/g, '') })}
                  />
                ))}
              </div>
              <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
              {request.error && <Alert tone="danger">{errorMessage(request.error)}</Alert>}
              <div className="uc-row">
                <Button
                  variant="primary"
                  disabled={reason.trim().length < 3 || !Object.values(qty).some((q) => q && q !== '0')}
                  loading={request.isPending}
                  onClick={() => request.mutate()}
                >
                  Request return
                </Button>
              </div>
            </div>
          )}
          {returnable.length > 0 && !windowOpen && o.returnDeadline && (
            <span className="uc-muted">The return window closed on {formatDateTime(o.returnDeadline)}.</span>
          )}
        </Card>
      )}
      {o.messages.length > 0 && (
        <Card title="Updates">
          <ul>
            {o.messages.map((m, i) => (
              <li key={i}>
                {m.subject} · {formatDateTime(m.createdAt)}
              </li>
            ))}
          </ul>
          <span className="uc-hint">
            These updates are shown here; e-mail delivery is not set up for this store yet.
          </span>
        </Card>
      )}
    </>
  );
}
