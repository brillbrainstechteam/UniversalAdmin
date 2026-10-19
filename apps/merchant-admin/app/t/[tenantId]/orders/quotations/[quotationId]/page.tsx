'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Order, Quotation } from '@uc/contracts';
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  TextField,
  errorMessage,
  formatDateTime,
  useToast,
} from '@uc/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { OrdersTabs, Status } from '../../../../../../lib/orders';
import { QuoteLineView, money } from '../../../../../../lib/pricing';
import { useTenant, useTenantQuery } from '../../../../../../lib/tenant';

export default function QuotationPage() {
  const { quotationId } = useParams<{ quotationId: string }>();
  const { api, can, tenantId, context } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const enabled = can('orders.read') && context.features.includes('orders');
  const tz = context.tenant.timezone;
  const q = useTenantQuery<Quotation>(
    ['orders', 'quotation', quotationId],
    `/v1/admin/quotations/${quotationId}`,
    undefined,
    enabled,
  );
  const [dialog, setDialog] = useState<'accept' | 'cancel' | null>(null);
  const [note, setNote] = useState('');
  const refresh = (msg: string) => {
    void qc.invalidateQueries({ queryKey: ['t', tenantId, 'orders'] });
    setDialog(null);
    toast(msg);
  };
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body: Record<string, unknown> }) =>
      api(`/v1/admin/quotations/${quotationId}/${path}`, {
        method: 'POST',
        body: { version: q.data!.version, ...body },
      }),
    onSuccess: (_r, v) =>
      refresh(
        v.path === 'send'
          ? 'Quotation sent — price frozen'
          : v.path === 'accept'
            ? 'Acceptance recorded'
            : 'Quotation cancelled',
      ),
  });
  const convert = useMutation({
    mutationFn: () =>
      api<Order>(`/v1/admin/quotations/${quotationId}/convert`, {
        method: 'POST',
        body: { version: q.data!.version },
      }),
    onSuccess: (o) => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'orders'] });
      router.push(`/t/${tenantId}/orders/${o.id}`);
    },
  });
  if (!enabled) return <ForbiddenState />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <LoadingState />;
  const x = q.data;
  const manage = can('orders.manage');
  const expired = new Date(x.validUntil).getTime() <= Date.now();
  return (
    <>
      <PageHeader
        title={`Quotation ${x.number}`}
        description={`For ${x.contact.name} (${x.contact.email}) · valid until ${formatDateTime(x.validUntil, tz)}${x.createdBy ? ` · by ${x.createdBy.name}` : ''}`}
        actions={
          manage && (
            <>
              {x.status === 'draft' && (
                <Button
                  variant="primary"
                  loading={act.isPending}
                  onClick={() => act.mutate({ path: 'send', body: {} })}
                >
                  Send (freeze price)
                </Button>
              )}
              {x.status === 'sent' && !expired && (
                <Button variant="primary" onClick={() => setDialog('accept')}>
                  Record acceptance
                </Button>
              )}
              {x.status === 'accepted' && !expired && (
                <Button variant="primary" loading={convert.isPending} onClick={() => convert.mutate()}>
                  Convert to order
                </Button>
              )}
              {['draft', 'sent', 'accepted'].includes(x.status) && (
                <Button variant="danger" onClick={() => setDialog('cancel')}>
                  Cancel
                </Button>
              )}
            </>
          )
        }
      />
      <OrdersTabs />
      <div className="uc-row">
        <Status value={x.status} />
        {x.orderId && <Link href={`/t/${tenantId}/orders/${x.orderId}`}>Open the order</Link>}
      </div>
      {expired && ['sent', 'accepted'].includes(x.status) && (
        <Alert tone="warning">
          This quotation has passed its validity date and can no longer be accepted or converted.
        </Alert>
      )}
      {x.acceptanceNote && (
        <Alert tone="success">
          Accepted {x.acceptedAt ? formatDateTime(x.acceptedAt, tz) : ''}: {x.acceptanceNote}
        </Alert>
      )}
      {x.cancelReason && <Alert tone="info">Cancelled: {x.cancelReason}</Alert>}
      {(act.error || convert.error) && (
        <Alert tone="danger">{errorMessage(act.error ?? convert.error)}</Alert>
      )}
      {x.notes && (
        <Card title="Notes">
          <p>{x.notes}</p>
        </Card>
      )}
      {x.priceQuote ? (
        <>
          <Card title={`Frozen price ${money(x.priceQuote.totalMinor, x.priceQuote.currency)}`}>
            <span className="uc-muted">
              Frozen when sent on {x.sentAt ? formatDateTime(x.sentAt, tz) : '—'}; the order is created at
              exactly this price.
            </span>
          </Card>
          {x.priceQuote.lines.map((l, i) => (
            <Card key={i} title={`Line ${i + 1}`}>
              <QuoteLineView line={l} />
            </Card>
          ))}
        </>
      ) : (
        <Card title="Lines (not priced yet)">
          <ul>
            {x.lines.map((l, i) => (
              <li key={i} className="uc-mono">
                {l.serialItemId
                  ? `piece ${l.serialItemId.slice(0, 8)}…`
                  : `variant ${l.variantId.slice(0, 8)}…`}{' '}
                × {l.quantity}
              </li>
            ))}
          </ul>
          <span className="uc-muted">The price is calculated and frozen when you send the quotation.</span>
        </Card>
      )}
      <Dialog
        open={dialog === 'accept'}
        title="Record the customer's acceptance"
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={act.isPending}
              onClick={() => act.mutate({ path: 'accept', body: { note } })}
            >
              Record acceptance
            </Button>
          </>
        }
      >
        <TextField
          label="Who accepted and how"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          hint="e.g. Accepted by email from the buyer on 19 Oct"
        />
      </Dialog>
      <ConfirmDialog
        open={dialog === 'cancel'}
        title={`Cancel quotation ${x.number}`}
        description="The quotation can no longer be accepted or converted."
        confirmLabel="Cancel quotation"
        tone="danger"
        requireReason
        loading={act.isPending}
        error={act.error ? errorMessage(act.error) : null}
        onConfirm={(reason) => act.mutate({ path: 'cancel', body: { reason } })}
        onClose={() => setDialog(null)}
      />
    </>
  );
}
