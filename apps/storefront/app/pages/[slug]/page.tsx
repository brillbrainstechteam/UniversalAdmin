'use client';

import { useQuery } from '@tanstack/react-query';
import type { ContentBlock, Page, StorefrontPage } from '@uc/contracts';
import { ApiError, EmptyState, ErrorState, LoadingState, PageHeader } from '@uc/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { shopApi } from '../../../lib/shop';

interface Summary {
  slug: string;
  title: string;
  image: { url: string; altText: string } | null;
}

function Products({ title, collection }: { title: string | null; collection: string }) {
  const list = useQuery({
    queryKey: ['collection-products', collection],
    queryFn: () => shopApi<Page<Summary>>('/catalog/products', { query: { collection, limit: 8 } }),
  });
  if (!list.data || list.data.items.length === 0) return null;
  return (
    <section className="uc-stack">
      {title && <h2>{title}</h2>}
      <ul
        style={{
          listStyle: 'none',
          padding: 0,
          display: 'grid',
          gap: 16,
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
        }}
      >
        {list.data.items.map((p) => (
          <li key={p.slug}>
            <Link href={`/products/${p.slug}`}>{p.title}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Block({ b }: { b: ContentBlock }) {
  switch (b.type) {
    case 'heading':
      return b.level === 3 ? <h3>{b.text}</h3> : <h2>{b.text}</h2>;
    case 'text':
      return (
        <>
          {b.text.split(/\n{2,}/).map((para, i) => (
            <p key={i} style={{ whiteSpace: 'pre-line' }}>
              {para}
            </p>
          ))}
        </>
      );
    case 'image':
      return <img src={b.url} alt={b.alt} style={{ maxWidth: '100%', borderRadius: 8 }} />;
    case 'products':
      return <Products title={b.title} collection={b.collectionSlug} />;
    case 'cta':
      return b.href.startsWith('/') ? (
        <Link href={b.href} className="uc-btn" data-variant="primary" style={{ alignSelf: 'flex-start' }}>
          {b.label}
        </Link>
      ) : (
        <a
          href={b.href}
          rel="noopener noreferrer"
          className="uc-btn"
          data-variant="primary"
          style={{ alignSelf: 'flex-start' }}
        >
          {b.label}
        </a>
      );
  }
}

export default function ContentPage() {
  const { slug } = useParams<{ slug: string }>();
  const page = useQuery({
    queryKey: ['page', slug],
    queryFn: () => shopApi<StorefrontPage>(`/pages/${slug}`),
    retry: false,
  });
  useEffect(() => {
    if (page.data) document.title = page.data.seoTitle ?? page.data.title;
  }, [page.data]);
  if (page.error instanceof ApiError && page.error.status === 404)
    return <EmptyState title="Page not found" />;
  if (page.error) return <ErrorState error={page.error} onRetry={() => void page.refetch()} />;
  if (!page.data) return <LoadingState />;
  return (
    <article className="uc-stack">
      <PageHeader title={page.data.title} description={page.data.seoDescription ?? undefined} />
      {page.data.blocks.map((b, i) => (
        <Block key={i} b={b} />
      ))}
    </article>
  );
}
