'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { OrderSettings, Rfq } from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
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
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { CompaniesTabs, RFQ_TONE } from '../../../../../../lib/companies';
import { useTenant, useTenantQuery } from '../../../../../../lib/tenant';

function inDays(days: number): string {
  const d = new Date(Date.now() + days * 24 * 3600_000);
  d.setSeconds(0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function RfqPage() {
  const { rfqId } = useParams<{ rfqId: string }>();
  const { api, can, tenantId, context } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const enabled = can('companies.read') && context.features.includes('b2b_companies');
  const tz = context.tenant.timezone;
  const rfq = useTenantQuery<Rfq>(['companies', 'rfq', rfqId], `/v1/admin/rfqs/${rfqId}`, undefined, enabled);
  const settings = useTenantQuery<OrderSettings>(
    ['orders', 'settings'],
    '/v1/admin/order-settings',
    undefined,
    enabled && can('orders.read'),
  );
  const [reply, setReply] = useState('');
  const [validUntil, setValidUntil] = useState(() => inDays(3));
  const [notes, setNotes] = useState('');
  const [declining, setDeclining] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['t', tenantId, 'companies'] });
  const send = useMutation({
    mutationFn: () => api(`/v1/admin/rfqs/${rfqId}/messages`, { method: 'POST', body: { body: reply } }),
    onSuccess: () => {
      setReply('');
      refresh();
    },
  });
  const quote = useMutation({
    mutationFn: () =>
      api(`/v1/admin/rfqs/${rfqId}/quote`, {
        method: 'POST',
        body: {
          version: rfq.data!.version,
          validUntil: new Date(validUntil).toISOString(),
          notes: notes.trim() || null,
        },
      }),
    onSuccess: () => {
      refresh();
      toast('Quotation sent — price frozen until its validity date');
    },
  });
  const decline = useMutation({
    mutationFn: (reason: string) =>
      api(`/v1/admin/rfqs/${rfqId}/decline`, {
        method: 'POST',
        body: { version: rfq.data!.version, reason },
      }),
    onSuccess: () => {
      setDeclining(false);
      refresh();
      toast('RFQ declined');
    },
  });
  if (!enabled) return <ForbiddenState />;
  if (rfq.error) return <ErrorState error={rfq.error} onRetry={() => void rfq.refetch()} />;
  if (!rfq.data) return <LoadingState />;
  const r = rfq.data;
  const manage = can('orders.manage');
  return (
    <>
      <PageHeader
        title={`RFQ ${r.number}`}
        description={`${r.company.name} · ${r.buyer.name} (${r.buyer.email}) · received ${formatDateTime(r.createdAt, tz)}${r.neededBy ? ` · needed by ${formatDateTime(r.neededBy, tz)}` : ''}`}
        actions={
          manage &&
          r.status === 'submitted' && (
            <Button variant="danger" onClick={() => setDeclining(true)}>
              Decline
            </Button>
          )
        }
      />
      <CompaniesTabs />
      <div className="uc-row">
        <Badge tone={RFQ_TONE[r.status]}>{r.status}</Badge>
        <Link href={`/t/${tenantId}/companies/${r.company.id}`}>Open company</Link>
        {r.quotationId && (
          <Link href={`/t/${tenantId}/orders/quotations/${r.quotationId}`}>Open quotation</Link>
        )}
      </div>
      <Card title="Requested lines">
        <ol>
          {r.items.map((l, i) => (
            <li key={i}>
              <span className="uc-mono">{l.sku}</span> {l.title}
              {l.serialTag && (
                <>
                  {' '}
                  · piece <span className="uc-mono">{l.serialTag}</span>
                </>
              )}{' '}
              × {l.quantity}
              {l.note && <span className="uc-muted"> — {l.note}</span>}
            </li>
          ))}
        </ol>
      </Card>
      <Card title="Conversation">
        <ol className="uc-stack" style={{ paddingLeft: 20 }}>
          {r.messages.map((m) => (
            <li key={m.id}>
              <strong>{m.author === 'staff' ? `${m.authorName} (staff)` : m.authorName}</strong> ·{' '}
              {formatDateTime(m.createdAt, tz)}
              <div>{m.body}</div>
            </li>
          ))}
        </ol>
        {manage && ['submitted', 'quoted'].includes(r.status) && (
          <div className="uc-row">
            <TextField label="Reply" value={reply} onChange={(e) => setReply(e.target.value)} />
            <Button disabled={!reply.trim()} loading={send.isPending} onClick={() => send.mutate()}>
              Send reply
            </Button>
          </div>
        )}
      </Card>
      {manage && r.status === 'submitted' && (
        <Card title="Send quotation">
          <div className="uc-form-grid">
            <TextField
              label="Valid until"
              type="datetime-local"
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
              hint={settings.data ? `At most ${settings.data.quotationMaxDays} days ahead` : undefined}
            />
            <TextField
              label="Notes for the buyer (optional)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <span className="uc-muted">
            Lines are priced with the company&apos;s contract book and frozen until the validity date.
          </span>
          <div>
            <Button variant="primary" loading={quote.isPending} onClick={() => quote.mutate()}>
              Price and send quotation
            </Button>
          </div>
          {quote.error && <Alert tone="danger">{errorMessage(quote.error)}</Alert>}
        </Card>
      )}
      <ConfirmDialog
        open={declining}
        title={`Decline ${r.number}`}
        description="The buyer sees the reason in the RFQ thread."
        confirmLabel="Decline"
        tone="danger"
        requireReason
        loading={decline.isPending}
        error={decline.error ? errorMessage(decline.error) : null}
        onConfirm={(reason) => decline.mutate(reason)}
        onClose={() => setDeclining(false)}
      />
    </>
  );
}
