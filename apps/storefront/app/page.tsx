'use client';

import { useQuery } from '@tanstack/react-query';
import type { Page } from '@uc/contracts';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  SelectField,
  TextField,
  useCursorPagination,
} from '@uc/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Pager } from '../lib/pager';
import { shopApi } from '../lib/shop';

interface Summary {
  slug: string;
  title: string;
  brand: string | null;
  productType: 'standard' | 'jewellery';
  image: { url: string; altText: string } | null;
}

export default function ShopPage() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [category, setCategory] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const pager = useCursorPagination(`${debounced}|${category}`);
  const cats = useQuery({
    queryKey: ['categories'],
    queryFn: () => shopApi<{ items: { slug: string; name: string }[] }>('/catalog/categories'),
  });
  const list = useQuery({
    queryKey: ['products', debounced, category, pager.cursor],
    queryFn: () =>
      shopApi<Page<Summary>>('/catalog/products', {
        query: { limit: 24, q: debounced, category, cursor: pager.cursor ?? undefined },
      }),
  });
  return (
    <>
      <PageHeader title="Shop" />
      <div className="uc-filters" role="search">
        <TextField
          label="Search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search products"
        />
        <SelectField
          label="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          options={[
            { value: '', label: 'All' },
            ...(cats.data?.items ?? []).map((c) => ({ value: c.slug, label: c.name })),
          ]}
        />
      </div>
      {list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data ? (
        <LoadingState />
      ) : list.data.items.length === 0 ? (
        <EmptyState title="No products found" description="Try another search or category." />
      ) : (
        <ul
          aria-label="Products"
          style={{
            listStyle: 'none',
            padding: 0,
            display: 'grid',
            gap: 16,
            gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          }}
        >
          {list.data.items.map((p) => (
            <li key={p.slug} className="uc-card" style={{ margin: 0 }}>
              <Link href={`/products/${p.slug}`} style={{ color: 'inherit', display: 'block' }}>
                {p.image ? (
                  <img
                    src={`/api${p.image.url}`}
                    alt={p.image.altText}
                    style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 6 }}
                  />
                ) : (
                  <div
                    aria-hidden
                    style={{
                      width: '100%',
                      aspectRatio: '1',
                      background: 'rgba(0,0,0,0.05)',
                      borderRadius: 6,
                    }}
                  />
                )}
                <strong style={{ display: 'block', marginTop: 8 }}>{p.title}</strong>
                {p.brand && <span className="uc-muted">{p.brand}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {list.data && <Pager {...pager.controls(list.data.nextCursor)} />}
    </>
  );
}
