'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Order } from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  errorMessage,
  formatDateTime,
  useToast,
} from '@uc/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { FulfillmentPanel, MessagesPanel, RefundsPanel, ReturnsPanel } from '../../../../../lib/fulfillment';
import { ORIGIN_LABELS, OrdersTabs, Status } from '../../../../../lib/orders';
import { QuoteLineView, money } from '../../../../../lib/pricing';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

const EVENT_LABELS: Record<string, string> = {
  created: 'Order created (stock held)',
  confirmed: 'Confirmed (stock committed)',
  stock_exception: 'Stock exception — needs staff action',
  payment_started: 'Payment started (sandbox)',
  payment_failed: 'Payment declined',
  payment_captured: 'Payment captured (sandbox)',
  export_queued: 'Queued for ERP export',
  cancelled: 'Cancelled (stock released)',
  rejected: 'Rejected (stock released)',
  expired: 'Expired (stock released)',
  refund_due: 'Refund due',
  shipment_packed: 'Shipment packed',
  shipment_shipped: 'Shipment dispatched (stock left)',
  shipment_delivered: 'Shipment delivered',
  shipment_cancelled: 'Shipment unpacked',
  remaining_cancelled: 'Unshipped items cancelled (stock released)',
  return_requested: 'Return requested',
  return_approved: 'Return approved',
  return_rejected: 'Return rejected',
  return_received: 'Return received',
  refund_requested: 'Refund requested (sandbox)',
  refund_succeeded: 'Refund succeeded (sandbox)',
  refund_failed: 'Refund declined',
};

export default function OrderPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const { api, can, tenantId, context } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const enabled = can('orders.read') && context.features.includes('orders');
  const tz = context.tenant.timezone;
  const order = useTenantQuery<Order>(
    ['orders', 'order', orderId],
    `/v1/admin/orders/${orderId}`,
    undefined,
    enabled,
  );
  const [dialog, setDialog] = useState<'cancel' | 'reject' | null>(null);
  const done = (message: string) => {
    void qc.invalidateQueries({ queryKey: ['t', tenantId, 'orders'] });
    setDialog(null);
    toast(message);
  };
  const approve = useMutation({
    mutationFn: () => api(`/v1/admin/orders/${orderId}/approve`, { method: 'POST', body: {} }),
    onSuccess: () => done('Order approved'),
  });
  const reject = useMutation({
    mutationFn: (reason: string) =>
      api(`/v1/admin/orders/${orderId}/reject`, { method: 'POST', body: { reason } }),
    onSuccess: () => done('Order rejected; stock released'),
  });
  const cancel = useMutation({
    mutationFn: (reason: string) =>
      api(`/v1/admin/orders/${orderId}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: () => done('Order cancelled; stock released'),
  });
  if (!enabled) return <ForbiddenState />;
  if (order.error) return <ErrorState error={order.error} onRetry={() => void order.refetch()} />;
  if (!order.data) return <LoadingState />;
  const o = order.data;
  const m = (v: string) => money(v, o.currency);
  const own = o.createdBy?.id === context.user.id;
  return (
    <>
      <PageHeader
        title={`Order ${o.number}`}
        description={`${ORIGIN_LABELS[o.origin]} order${o.channel ? ` on ${o.channel.name}` : ''} · created ${formatDateTime(o.createdAt, tz)}${o.createdBy ? ` by ${o.createdBy.name}` : ''}`}
        actions={
          <>
            {o.status === 'awaiting_approval' && can('orders.approve') && !own && (
              <>
                <Button variant="primary" loading={approve.isPending} onClick={() => approve.mutate()}>
                  Approve
                </Button>
                <Button onClick={() => setDialog('reject')}>Reject</Button>
              </>
            )}
            {o.status !== 'cancelled' && o.fulfillmentStatus === 'unfulfilled' && can('orders.manage') && (
              <Button variant="danger" onClick={() => setDialog('cancel')}>
                Cancel order
              </Button>
            )}
          </>
        }
      />
      <OrdersTabs />
      <div className="uc-row" style={{ flexWrap: 'wrap' }}>
        <Status value={o.status} />
        <Status value={o.paymentStatus} />
        {o.status === 'confirmed' && <Status value={o.fulfillmentStatus} />}
        {o.customer && (
          <Link href={`/t/${tenantId}/customers/${o.customer.id}`}>Customer account: {o.customer.name}</Link>
        )}
        <Badge>{o.paymentTerms === 'prepaid' ? 'Prepaid' : 'On account'}</Badge>
        {o.quotationId && (
          <Link href={`/t/${tenantId}/orders/quotations/${o.quotationId}`}>From quotation</Link>
        )}
      </div>
      {o.status === 'awaiting_approval' && own && (
        <Alert tone="info">
          You created this order, so someone else with approval rights must approve it.
        </Alert>
      )}
      {o.status === 'on_hold' && (
        <Alert tone="danger" title="On hold">
          Payment arrived but some stock was no longer available. Cancel the order (a refund becomes due) or
          arrange the items.
        </Alert>
      )}
      {o.paymentStatus === 'refund_due' && (
        <Alert tone="warning" title="Refund due">
          {m(o.refundDueMinor)} must be refunded to the customer. Use Issue refund below.
        </Alert>
      )}
      {o.warnings.map((w) => (
        <Alert key={w} tone="warning">
          {w}
        </Alert>
      ))}
      {approve.error && <Alert tone="danger">{errorMessage(approve.error)}</Alert>}
      <Card title="Summary">
        <dl className="uc-row" style={{ flexWrap: 'wrap', gap: 24 }}>
          <div>
            <dt className="uc-muted">Customer</dt>
            <dd>
              {o.contact.name} · {o.contact.email}
              {o.contact.phone ? ` · ${o.contact.phone}` : ''}
            </dd>
          </div>
          <div>
            <dt className="uc-muted">Ship to</dt>
            <dd>
              {o.shippingAddress
                ? `${o.shippingAddress.line1}, ${o.shippingAddress.city} ${o.shippingAddress.countryCode}`
                : '—'}
            </dd>
          </div>
          <div>
            <dt className="uc-muted">Subtotal / discount / tax</dt>
            <dd className="uc-mono">
              {m(o.subtotalMinor)} / −{m(o.discountMinor)} / {m(o.taxMinor)}
            </dd>
          </div>
          <div>
            <dt className="uc-muted">Total</dt>
            <dd className="uc-mono">
              <strong>{m(o.totalMinor)}</strong>
            </dd>
          </div>
          {o.expiresAt && (
            <div>
              <dt className="uc-muted">
                {o.status === 'awaiting_approval' ? 'Approval needed by' : 'Payment window until'}
              </dt>
              <dd>{formatDateTime(o.expiresAt, tz)}</dd>
            </div>
          )}
        </dl>
        {o.note && <p>{o.note}</p>}
      </Card>
      {o.lines.map((l) => (
        <Card key={l.lineNo} title={`Line ${l.lineNo} · ${m(l.totalMinor)}`}>
          <span className="uc-row">
            Stock:{' '}
            {l.reservation ? (
              <>
                <Status value={l.reservation.status === 'held' ? 'pending' : l.reservation.status} /> at{' '}
                {l.reservation.locationName}
              </>
            ) : (
              '—'
            )}
          </span>
          <QuoteLineView line={l.priceSnapshot} />
        </Card>
      ))}
      <Card title="Payments">
        <DataTable
          caption="Payments"
          rows={o.payments}
          rowKey={(p) => p.id}
          empty={
            <EmptyState
              title={
                o.paymentTerms === 'on_account' ? 'On account — no online payment' : 'No payment attempts yet'
              }
            />
          }
          columns={[
            { key: 'when', header: 'When', render: (p) => formatDateTime(p.createdAt, tz) },
            { key: 'provider', header: 'Provider', render: () => <Badge tone="warning">SANDBOX</Badge> },
            {
              key: 'status',
              header: 'Status',
              render: (p) => <Status value={p.status === 'captured' ? 'paid' : p.status} />,
            },
            {
              key: 'amount',
              header: 'Amount',
              render: (p) => <span className="uc-mono">{money(p.amountMinor, p.currency)}</span>,
            },
            { key: 'why', header: 'Note', render: (p) => p.failureReason ?? '—' },
          ]}
        />
      </Card>
      {o.exports.length > 0 && (
        <Card title="ERP export">
          <DataTable
            caption="ERP exports"
            rows={o.exports}
            rowKey={(x) => `${x.connectionName}:${x.reference}`}
            empty={<EmptyState title="Not exported" />}
            columns={[
              { key: 'conn', header: 'Connection', render: (x) => x.connectionName },
              {
                key: 'ref',
                header: 'Reference',
                render: (x) => <span className="uc-mono">{x.reference}</span>,
              },
              {
                key: 'status',
                header: 'Status',
                render: (x) => <Status value={x.status === 'acknowledged' ? 'confirmed' : x.status} />,
              },
              { key: 'ext', header: 'ERP number', render: (x) => x.externalRef ?? '—' },
            ]}
          />
        </Card>
      )}
      <FulfillmentPanel order={o} />
      <ReturnsPanel order={o} />
      <RefundsPanel order={o} />
      <MessagesPanel order={o} />
      <Card title="Timeline">
        <ol className="uc-stack" style={{ paddingLeft: 20 }}>
          {o.events.map((e) => (
            <li key={e.id}>
              <strong>{EVENT_LABELS[e.type] ?? e.type}</strong> · {formatDateTime(e.createdAt, tz)} ·{' '}
              {e.actor?.name ?? 'System'}
              {e.note && <div className="uc-muted">{e.note}</div>}
            </li>
          ))}
        </ol>
      </Card>
      <ConfirmDialog
        open={dialog !== null}
        title={dialog === 'reject' ? `Reject order ${o.number}` : `Cancel order ${o.number}`}
        description={
          o.paymentStatus === 'paid'
            ? 'Held and committed stock is released. The captured payment becomes a refund due.'
            : 'Held and committed stock is released back to available.'
        }
        confirmLabel={dialog === 'reject' ? 'Reject' : 'Cancel order'}
        tone="danger"
        requireReason
        loading={cancel.isPending || reject.isPending}
        error={cancel.error ? errorMessage(cancel.error) : reject.error ? errorMessage(reject.error) : null}
        onConfirm={(reason) => (dialog === 'reject' ? reject.mutate(reason) : cancel.mutate(reason))}
        onClose={() => setDialog(null)}
      />
    </>
  );
}
