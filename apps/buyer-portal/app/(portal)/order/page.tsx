'use client';

import type { BuyerOrder, BuyerPriceResponse } from '@uc/contracts';
import {
  Alert,
  ApiError,
  Button,
  Card,
  PageHeader,
  SelectField,
  TextField,
  errorMessage,
  formatDateTime,
} from '@uc/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { buyerApi, useBuyer } from '../../../lib/buyer';

type Line = { sku: string; serialTag: string | null; quantity: number };

/** "SKU, 5" → 5 pieces; "SKU, TAG-1" → that exact piece. One line per row; commas, tabs or spaces separate. */
function parse(text: string): { lines: Line[]; errors: string[] } {
  const lines: Line[] = [];
  const errors: string[] = [];
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((row, i) => {
      const [sku, second] = row.split(/[,\t ]+/);
      if (!sku) return;
      if (!second || /^\d{1,6}$/.test(second)) {
        const qty = second ? Number.parseInt(second, 10) : 1;
        if (qty < 1) errors.push(`Row ${i + 1}: quantity must be at least 1`);
        else lines.push({ sku, serialTag: null, quantity: qty });
      } else lines.push({ sku, serialTag: second, quantity: 1 });
    });
  return { lines, errors };
}

function QuickOrder() {
  const { me, money } = useBuyer();
  const router = useRouter();
  const params = useSearchParams();
  const [text, setText] = useState(() =>
    params.get('sku') ? `${params.get('sku')}, ${params.get('qty') ?? 1}` : '',
  );
  const [locationId, setLocationId] = useState(me.company?.locations[0]?.id ?? '');
  const [po, setPo] = useState('');
  const [quote, setQuote] = useState<BuyerPriceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowProblems, setRowProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  async function price() {
    const { lines, errors } = parse(text);
    setQuote(null);
    setChanged(false);
    setError(null);
    setRowProblems(errors);
    if (errors.length || !lines.length) return;
    setBusy(true);
    try {
      setQuote(await buyerApi<BuyerPriceResponse>('/price', { method: 'POST', body: { lines } }));
    } catch (e) {
      const details =
        e instanceof ApiError
          ? (e.details as { problems?: { line: number; message: string }[] } | undefined)
          : undefined;
      if (details?.problems)
        setRowProblems(
          details.problems.map((p) => (p.line >= 0 ? `Row ${p.line + 1}: ${p.message}` : p.message)),
        );
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function place() {
    if (!quote) return;
    setBusy(true);
    setError(null);
    try {
      const order = await buyerApi<BuyerOrder>('/orders', {
        method: 'POST',
        body: {
          quoteId: quote.quoteId,
          acknowledgedTotalMinor: quote.totalMinor,
          locationId,
          poNumber: po.trim() || null,
        },
      });
      router.push(`/orders/${order.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PRICE_CHANGED') {
        setQuote((e.details as { quote: BuyerPriceResponse }).quote);
        setChanged(true);
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const blocking = quote?.problems.length ?? 0;
  return (
    <>
      <PageHeader
        title="Quick order"
        description="Paste one line per item: SKU and quantity (or SKU and piece tag for a specific piece)."
      />
      <Card title="Items">
        <label className="uc-field">
          <span className="uc-label">Lines</span>
          <textarea
            className="uc-input"
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'AUR-BAND22-12, 10\nAUR-BAND22-14, AUR-T-0002'}
            aria-describedby="lines-hint"
          />
          <span id="lines-hint" className="uc-hint">
            Prices are calculated by your supplier&apos;s system at today&apos;s approved rates.
          </span>
        </label>
        <div className="uc-row">
          <Button variant="primary" loading={busy && !quote} onClick={() => void price()}>
            Get prices
          </Button>
        </div>
        {rowProblems.map((p) => (
          <Alert key={p} tone="danger">
            {p}
          </Alert>
        ))}
      </Card>
      {quote && (
        <Card title={`Total ${money(quote.totalMinor)}`}>
          {changed && (
            <Alert tone="warning">
              Prices changed since your last quote. Review the new total, then place the order again.
            </Alert>
          )}
          <div className="uc-table-wrap">
            <table className="uc-table">
              <caption className="uc-sr-only">Priced lines</caption>
              <thead>
                <tr>
                  <th scope="col">SKU</th>
                  <th scope="col">Item</th>
                  <th scope="col">Qty</th>
                  <th scope="col">Price build-up</th>
                  <th scope="col">Line total</th>
                </tr>
              </thead>
              <tbody>
                {quote.lines.map((l, i) => (
                  <tr key={i}>
                    <td className="uc-mono">{l.sku}</td>
                    <td>{l.title}</td>
                    <td>{l.quantity}</td>
                    <td className="uc-muted">
                      {l.components.map((c) => `${c.label}: ${money(c.amountMinor)}`).join(' · ')}
                    </td>
                    <td className="uc-mono">{money(l.totalMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {quote.problems.map((p) => (
            <Alert key={p.message} tone="danger">
              {p.message}
            </Alert>
          ))}
          <span className="uc-muted">
            Prices are held until {formatDateTime(quote.expiresAt)}; after that they are recalculated when you
            order.
          </span>
          {quote.notes
            .filter((n) => !n.startsWith('Prices are held until'))
            .map((n) => (
              <span key={n} className="uc-muted">
                {n}
              </span>
            ))}
          <div className="uc-form-grid">
            <SelectField
              label="Deliver to"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              options={(me.company?.locations ?? []).map((l) => ({ value: l.id, label: l.name }))}
            />
            <TextField label="Your PO number (optional)" value={po} onChange={(e) => setPo(e.target.value)} />
          </div>
          {me.company?.orderLimitMinor && BigInt(quote.totalMinor) > BigInt(me.company.orderLimitMinor) && (
            <Alert tone="info">
              This is above your order limit, so a company approver will review it after you place it.
            </Alert>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="uc-row">
            <Button
              variant="primary"
              disabled={blocking > 0 || !locationId}
              loading={busy}
              onClick={() => void place()}
            >
              Place order for {money(quote.totalMinor)}
            </Button>
          </div>
        </Card>
      )}
      {!quote && error && <Alert tone="danger">{error}</Alert>}
    </>
  );
}

export default function QuickOrderPage() {
  return (
    <Suspense>
      <QuickOrder />
    </Suspense>
  );
}
