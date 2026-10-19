'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Rfq } from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  ErrorState,
  LoadingState,
  PageHeader,
  errorMessage,
  formatDateTime,
} from '@uc/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { buyerApi } from '../../../../lib/buyer';

export default function RfqPage() {
  const { rfqId } = useParams<{ rfqId: string }>();
  const qc = useQueryClient();
  const rfq = useQuery({ queryKey: ['rfq', rfqId], queryFn: () => buyerApi<Rfq>(`/rfqs/${rfqId}`) });
  const [body, setBody] = useState('');
  const send = useMutation({
    mutationFn: () =>
      buyerApi<Rfq>(`/rfqs/${rfqId}/messages`, { method: 'POST', body: { body: body.trim() } }),
    onSuccess: (r) => {
      qc.setQueryData(['rfq', rfqId], r);
      setBody('');
    },
  });
  if (rfq.error) return <ErrorState error={rfq.error} onRetry={() => void rfq.refetch()} />;
  if (!rfq.data) return <LoadingState />;
  const r = rfq.data;
  const open = r.status === 'submitted' || r.status === 'quoted';
  return (
    <>
      <PageHeader
        title={`Request ${r.number}`}
        description={`Sent ${formatDateTime(r.createdAt)} by ${r.buyer.name}${r.neededBy ? ` · needed by ${formatDateTime(r.neededBy)}` : ''}`}
      />
      <div className="uc-row">
        <Badge>{r.status}</Badge>
        {r.quotationId && <Link href="/quotations">View the quotation</Link>}
      </div>
      <Card title="Requested items">
        <div className="uc-table-wrap">
          <table className="uc-table">
            <caption className="uc-sr-only">Requested items</caption>
            <thead>
              <tr>
                <th scope="col">SKU</th>
                <th scope="col">Item</th>
                <th scope="col">Qty</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {r.items.map((l, i) => (
                <tr key={i}>
                  <td className="uc-mono">{l.sku}</td>
                  <td>{l.title}</td>
                  <td>{l.quantity}</td>
                  <td>{l.note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {r.note && <span className="uc-muted">Note: {r.note}</span>}
      </Card>
      <Card title="Conversation">
        {r.messages.length === 0 && <span className="uc-muted">No messages yet.</span>}
        <ol className="uc-stack" aria-label="Messages">
          {r.messages.map((m) => (
            <li key={m.id}>
              <strong>{m.author === 'staff' ? `${m.authorName} (supplier)` : m.authorName}</strong>{' '}
              <span className="uc-muted">{formatDateTime(m.createdAt)}</span>
              <p>{m.body}</p>
            </li>
          ))}
        </ol>
        {open && (
          <>
            <label className="uc-field">
              <span className="uc-label">Message</span>
              <textarea
                className="uc-input"
                rows={3}
                value={body}
                maxLength={2000}
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
            {send.error && <Alert tone="danger">{errorMessage(send.error)}</Alert>}
            <div className="uc-row">
              <Button
                variant="primary"
                disabled={!body.trim()}
                loading={send.isPending}
                onClick={() => send.mutate()}
              >
                Send message
              </Button>
            </div>
          </>
        )}
      </Card>
    </>
  );
}
