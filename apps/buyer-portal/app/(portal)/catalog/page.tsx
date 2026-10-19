'use client';

import { useQuery } from '@tanstack/react-query';
import type { Page } from '@uc/contracts';
import { Card, DataTable, EmptyState, PageHeader, TextField, useCursorPagination } from '@uc/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { buyerApi } from '../../../lib/buyer';

interface Product {
  productId: string;
  title: string;
  variants: { id: string; sku: string; title: string; moq: number | null }[];
}

export default function CatalogPage() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const pager = useCursorPagination(debounced);
  const list = useQuery({
    queryKey: ['catalog', debounced, pager.cursor],
    queryFn: () =>
      buyerApi<Page<Product>>(
        `/catalog?${new URLSearchParams({ limit: '25', ...(debounced ? { q: debounced } : {}), ...(pager.cursor ? { cursor: pager.cursor } : {}) })}`,
      ),
  });
  return (
    <>
      <PageHeader
        title="Catalog"
        description="Products your company can order. Use Quick order to price and order by SKU."
      />
      <Card>
        <div className="uc-filters" role="search">
          <TextField
            label="Search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Title or SKU"
          />
        </div>
        <DataTable
          caption="Catalog"
          rows={list.data?.items.flatMap((p) => p.variants.map((v) => ({ ...v, product: p.title })))}
          isLoading={list.isLoading}
          error={list.error}
          rowKey={(v) => v.id}
          pagination={pager.controls(list.data?.nextCursor)}
          empty={<EmptyState title="Nothing found" />}
          columns={[
            { key: 'sku', header: 'SKU', render: (v) => <span className="uc-mono">{v.sku}</span> },
            {
              key: 'title',
              header: 'Product',
              render: (v) => (v.title ? `${v.product} — ${v.title}` : v.product),
            },
            { key: 'moq', header: 'Minimum quantity', render: (v) => v.moq ?? '—' },
            {
              key: 'act',
              header: 'Order',
              render: (v) => (
                <Link
                  className="uc-btn"
                  data-size="sm"
                  href={`/order?sku=${encodeURIComponent(v.sku)}&qty=${v.moq ?? 1}`}
                >
                  Order<span className="uc-sr-only"> {v.sku}</span>
                </Link>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}
