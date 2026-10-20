'use client';

import { useQuery } from '@tanstack/react-query';
import type { StorefrontPiece, StorefrontProduct, StorefrontQuote } from '@uc/contracts';
import {
  Alert,
  Button,
  Card,
  ErrorState,
  LoadingState,
  PageHeader,
  SelectField,
  TextField,
  errorMessage,
  formatDateTime,
} from '@uc/ui';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { shopApi, useCart, useMoney } from '../../../lib/shop';

const grams = (g: string | null) => (g ? `${Number.parseFloat(g).toFixed(3)} g` : '—');

export default function ProductPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const money = useMoney();
  const cart = useCart();
  const product = useQuery({
    queryKey: ['product', slug],
    queryFn: () => shopApi<StorefrontProduct>(`/catalog/products/${slug}`),
  });
  const isJewellery = product.data?.productType === 'jewellery';
  const pieces = useQuery({
    queryKey: ['pieces', slug],
    queryFn: () => shopApi<{ items: StorefrontPiece[] }>(`/catalog/products/${slug}/pieces`),
    enabled: !!isJewellery,
  });
  const [variantId, setVariantId] = useState('');
  const [pieceId, setPieceId] = useState('');
  const [qty, setQty] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (product.data && !variantId) setVariantId(product.data.variants[0]?.id ?? '');
  }, [product.data, variantId]);
  const variantPieces = (pieces.data?.items ?? []).filter((p) => p.variantId === variantId);
  const needsPiece = isJewellery && variantPieces.length > 0;
  const line = variantId
    ? needsPiece
      ? pieceId
        ? { variantId, serialItemId: pieceId, quantity: 1 }
        : null
      : { variantId, quantity: Math.max(1, Number.parseInt(qty || '1', 10)) }
    : null;
  // The server prices exactly what would be bought (actual weights for a piece); nothing is computed here.
  const quote = useQuery({
    queryKey: ['quote', line],
    queryFn: () => shopApi<StorefrontQuote>('/pricing-quotes', { method: 'POST', body: { lines: [line] } }),
    enabled: !!line,
    retry: false,
  });
  if (product.error) return <ErrorState error={product.error} onRetry={() => void product.refetch()} />;
  if (!product.data) return <LoadingState />;
  const p = product.data;
  const v = p.variants.find((x) => x.id === variantId);
  async function add() {
    if (!line) return;
    setAdding(true);
    setError(null);
    try {
      const current = cart.data?.lines ?? [];
      const rest = current.filter(
        (l) =>
          !(
            l.variantId === line.variantId &&
            (l.serialItemId ?? null) === ('serialItemId' in line ? line.serialItemId : null)
          ),
      );
      await cart.setLines([
        ...rest.map((l) => ({
          variantId: l.variantId,
          ...(l.serialItemId ? { serialItemId: l.serialItemId } : {}),
          quantity: l.quantity,
        })),
        line,
      ]);
      router.push('/cart');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setAdding(false);
    }
  }
  return (
    <>
      <PageHeader title={p.title} description={p.brand ?? undefined} />
      <div style={{ display: 'grid', gap: 24, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        <div className="uc-stack">
          {p.images[0] ? (
            <img
              src={`/api${p.images[0].url}`}
              alt={p.images[0].altText}
              style={{ width: '100%', borderRadius: 8 }}
            />
          ) : (
            <div
              aria-hidden
              style={{ width: '100%', aspectRatio: '1', background: 'rgba(0,0,0,0.05)', borderRadius: 8 }}
            />
          )}
          {p.description && <p>{p.description}</p>}
        </div>
        <Card>
          {p.variants.length > 1 && (
            <SelectField
              label="Option"
              value={variantId}
              onChange={(e) => {
                setVariantId(e.target.value);
                setPieceId('');
              }}
              options={p.variants.map((x) => ({ value: x.id, label: x.title }))}
            />
          )}
          {v?.jewellery && (
            <p className="uc-muted">
              {v.jewellery.purity} {v.jewellery.metal}
              {v.jewellery.netG ? ` · design weight about ${grams(v.jewellery.netG)} net` : ''}
            </p>
          )}
          {isJewellery && (
            <fieldset className="uc-stack" style={{ border: 0, padding: 0 }}>
              <legend className="uc-label">Choose your piece</legend>
              {pieces.isLoading && <LoadingState rows={2} />}
              {!pieces.isLoading && variantPieces.length === 0 && (
                <Alert tone="info">No pieces of this option are in stock right now.</Alert>
              )}
              {variantPieces.map((x) => (
                <label key={x.id} className="uc-row" style={{ gap: 8 }}>
                  <input
                    type="radio"
                    name="piece"
                    value={x.id}
                    checked={pieceId === x.id}
                    onChange={() => setPieceId(x.id)}
                  />
                  <span>
                    <strong>{x.tag}</strong> · {x.purity} · gross {grams(x.grossG)} · net {grams(x.netG)}
                    {x.stoneG ? ` · stones ${grams(x.stoneG)}` : ''}
                  </span>
                </label>
              ))}
              <span className="uc-hint">
                Each piece is weighed individually; the price is for the piece you choose.
              </span>
            </fieldset>
          )}
          {!isJewellery && (
            <TextField
              label="Quantity"
              inputMode="numeric"
              value={qty}
              onChange={(e) => setQty(e.target.value.replace(/\D/g, '').slice(0, 4))}
            />
          )}
          {quote.data && (
            <div className="uc-stack" aria-live="polite">
              <strong style={{ fontSize: 22 }}>{money(quote.data.totalMinor)}</strong>
              <details>
                <summary>How this price is made up</summary>
                <ul>
                  {quote.data.lines[0]?.components.map((c) => (
                    <li key={c.label}>
                      {c.label}: {money(c.amountMinor)}
                    </li>
                  ))}
                  {quote.data.lines[0] && quote.data.lines[0].taxMinor !== '0' && (
                    <li>Tax: {money(quote.data.lines[0].taxMinor)}</li>
                  )}
                </ul>
              </details>
              {quote.data.lines[0]?.rateAsOf && (
                <span className="uc-muted">
                  Metal rate as of {formatDateTime(quote.data.lines[0].rateAsOf)}. The price is checked again
                  at checkout.
                </span>
              )}
            </div>
          )}
          {quote.error && <Alert tone="warning">{errorMessage(quote.error)}</Alert>}
          {error && <Alert tone="danger">{error}</Alert>}
          <Button
            variant="primary"
            disabled={!line || !quote.data}
            loading={adding}
            onClick={() => void add()}
          >
            Add to cart
          </Button>
        </Card>
      </div>
    </>
  );
}
