'use client';

import {
  Alert,
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
import { useState } from 'react';
import { useCart, useMoney } from '../../lib/shop';

export default function CartPage() {
  const cart = useCart();
  const money = useMoney();
  const [error, setError] = useState<string | null>(null);
  if (cart.error) return <ErrorState error={cart.error} onRetry={() => void cart.refetch()} />;
  if (cart.isLoading) return <LoadingState />;
  const c = cart.data;
  if (!c || c.lines.length === 0)
    return (
      <>
        <PageHeader title="Cart" />
        <EmptyState title="Your cart is empty" description="Browse the shop to add something." />
        <Link href="/" className="uc-btn" data-variant="primary">
          Continue shopping
        </Link>
      </>
    );
  async function remove(i: number) {
    setError(null);
    try {
      await cart.setLines(
        c!.lines
          .filter((_, j) => j !== i)
          .map((l) => ({
            variantId: l.variantId,
            ...(l.serialItemId ? { serialItemId: l.serialItemId } : {}),
            quantity: l.quantity,
          })),
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <>
      <PageHeader title="Cart" />
      <Card>
        <div className="uc-table-wrap">
          <table className="uc-table">
            <caption className="uc-sr-only">Cart lines</caption>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Qty</th>
                <th scope="col">Price</th>
                <th scope="col">
                  <span className="uc-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(c.quote?.lines ?? []).map((l, i) => (
                <tr key={`${l.variantId}-${l.serialItemId ?? i}`}>
                  <td>{l.title}</td>
                  <td>{l.quantity}</td>
                  <td className="uc-mono">{money(l.totalMinor)}</td>
                  <td>
                    <Button size="sm" onClick={() => void remove(i)}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {c.quote && (
          <>
            <strong style={{ fontSize: 20 }}>Total {money(c.quote.totalMinor)}</strong>
            <span className="uc-muted">
              Prices shown are held until {formatDateTime(c.quote.expiresAt)}; checkout re-checks them and
              asks you to confirm any change.
            </span>
            {c.quote.notes.map((n) => (
              <span key={n} className="uc-muted">
                {n}
              </span>
            ))}
          </>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="uc-row">
          <Link href="/checkout" className="uc-btn" data-variant="primary">
            Checkout
          </Link>
          <Link href="/" className="uc-btn">
            Continue shopping
          </Link>
        </div>
      </Card>
    </>
  );
}
