'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BuyerOrder } from '@uc/contracts';
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  ErrorState,
  LoadingState,
  PageHeader,
  errorMessage,
  formatDateTime,
  useToast,
} from '@uc/ui';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { buyerApi, useBuyer } from '../../../../lib/buyer';
import { StatusBadge } from '../../../../lib/orders';

export default function OrderPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const { me, money } = useBuyer();
  const qc = useQueryClient();
  const toast = useToast();
  const order = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => buyerApi<BuyerOrder>(`/orders/${orderId}`),
  });
  const [rejecting, setRejecting] = useState(false);
  const done = (msg: string) => {
    void qc.invalidateQueries({ queryKey: ['order', orderId] });
    void qc.invalidateQueries({ queryKey: ['orders'] });
    setRejecting(false);
    toast(msg);
  };
  const approve = useMutation({
    mutationFn: () => buyerApi(`/orders/${orderId}/approve`, { method: 'POST', body: {} }),
    onSuccess: () => done('Order approved'),
  });
  const reject = useMutation({
    mutationFn: (reason: string) =>
      buyerApi(`/orders/${orderId}/reject`, { method: 'POST', body: { reason } }),
    onSuccess: () => done('Order rejected'),
  });
  if (order.error) return <ErrorState error={order.error} onRetry={() => void order.refetch()} />;
  if (!order.data) return <LoadingState />;
  const o = order.data;
  const canDecide = o.status === 'awaiting_buyer_approval' && me.company && me.company.role !== 'buyer';
  return (
    <>
      <PageHeader
        title={`Order ${o.number}`}
        description={`Placed ${formatDateTime(o.createdAt)}${o.placedBy ? ` by ${o.placedBy}` : ''}${o.location ? ` · deliver to ${o.location.name}` : ''}${o.poNumber ? ` · PO ${o.poNumber}` : ''}`}
        actions={
          canDecide && (
            <>
              <Button variant="primary" loading={approve.isPending} onClick={() => approve.mutate()}>
                Approve
              </Button>
              <Button onClick={() => setRejecting(true)}>Reject</Button>
            </>
          )
        }
      />
      <div className="uc-row">
        <StatusBadge status={o.status} />
      </div>
      {approve.error && <Alert tone="danger">{errorMessage(approve.error)}</Alert>}
      {o.approvalNote && <Alert tone="success">Approval note: {o.approvalNote}</Alert>}
      <Card title={`Total ${money(o.totalMinor)}`}>
        <div className="uc-table-wrap">
          <table className="uc-table">
            <caption className="uc-sr-only">Order lines</caption>
            <thead>
              <tr>
                <th scope="col">SKU</th>
                <th scope="col">Item</th>
                <th scope="col">Qty</th>
                <th scope="col">Line total</th>
              </tr>
            </thead>
            <tbody>
              {o.lines.map((l, i) => (
                <tr key={i}>
                  <td className="uc-mono">{l.sku}</td>
                  <td>
                    {l.title}
                    {l.serialTag && <span className="uc-mono"> · {l.serialTag}</span>}
                  </td>
                  <td>{l.quantity}</td>
                  <td className="uc-mono">{money(l.totalMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <span className="uc-muted">Prices are fixed on the order; later rate changes do not affect it.</span>
      </Card>
      <ConfirmDialog
        open={rejecting}
        title={`Reject order ${o.number}`}
        description="The reserved stock and credit are released."
        confirmLabel="Reject"
        tone="danger"
        requireReason
        loading={reject.isPending}
        error={reject.error ? errorMessage(reject.error) : null}
        onConfirm={(reason) => reject.mutate(reason)}
        onClose={() => setRejecting(false)}
      />
    </>
  );
}
