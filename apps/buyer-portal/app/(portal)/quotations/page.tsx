'use client';

import { useQuery } from '@tanstack/react-query';
import type { BuyerOrder, BuyerQuotation } from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  SelectField,
  TextField,
  errorMessage,
  formatDateTime,
} from '@uc/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { buyerApi, useBuyer } from '../../../lib/buyer';

function QuotationCard({ q }: { q: BuyerQuotation }) {
  const { me, money } = useBuyer();
  const router = useRouter();
  const [picked, setPicked] = useState<Set<number>>(() => new Set(q.lines.map((l) => l.index)));
  const [locationId, setLocationId] = useState(me.company?.locations[0]?.id ?? '');
  const [po, setPo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const acceptable = q.status === 'sent' && !q.orderId && new Date(q.validUntil) > new Date();
  const toggle = (i: number) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const all = picked.size === q.lines.length;
      const order = await buyerApi<BuyerOrder>(`/quotations/${q.id}/accept`, {
        method: 'POST',
        body: {
          locationId,
          poNumber: po.trim() || null,
          ...(all ? {} : { lineIndexes: [...picked].sort((a, b) => a - b) }),
        },
      });
      router.push(`/orders/${order.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title={`Quotation ${q.number}${q.totalMinor ? ` · ${money(q.totalMinor)}` : ''}`}>
      <div className="uc-row">
        <Badge tone={acceptable ? 'info' : undefined}>{q.orderId ? 'ordered' : q.status}</Badge>
        <span className="uc-muted">Valid until {formatDateTime(q.validUntil)}</span>
        {q.rfqId && <Link href={`/rfqs/${q.rfqId}`}>Your request</Link>}
        {q.orderId && <Link href={`/orders/${q.orderId}`}>View order</Link>}
      </div>
      {q.notes && <span className="uc-muted">Supplier note: {q.notes}</span>}
      <div className="uc-stack">
        {q.lines.map((l) =>
          acceptable ? (
            <Checkbox
              key={l.index}
              label={`${l.sku} · ${l.title} × ${l.quantity}`}
              description={money(l.totalMinor)}
              checked={picked.has(l.index)}
              onChange={() => toggle(l.index)}
            />
          ) : (
            <span key={l.index}>
              <span className="uc-mono">{l.sku}</span> · {l.title} × {l.quantity} — {money(l.totalMinor)}
            </span>
          ),
        )}
      </div>
      {acceptable && (
        <>
          <span className="uc-muted">
            Quoted prices are fixed until the quotation expires. Untick lines you do not want.
          </span>
          <div className="uc-form-grid">
            <SelectField
              label="Deliver to"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              options={(me.company?.locations ?? []).map((l) => ({ value: l.id, label: l.name }))}
            />
            <TextField label="Your PO number (optional)" value={po} onChange={(e) => setPo(e.target.value)} />
          </div>
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="uc-row">
            <Button
              variant="primary"
              disabled={picked.size === 0 || !locationId}
              loading={busy}
              onClick={() => void accept()}
            >
              {picked.size === q.lines.length
                ? 'Accept and order'
                : `Accept ${picked.size} of ${q.lines.length} lines`}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

export default function QuotationsPage() {
  const list = useQuery({
    queryKey: ['quotations'],
    queryFn: () => buyerApi<{ items: BuyerQuotation[] }>('/quotations'),
  });
  if (list.error) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  if (!list.data) return <LoadingState />;
  return (
    <>
      <PageHeader title="Quotations" description="Prices your supplier has quoted for your company." />
      {list.data.items.length === 0 ? (
        <EmptyState title="No quotations yet" />
      ) : (
        list.data.items.map((q) => <QuotationCard key={q.id} q={q} />)
      )}
    </>
  );
}
