'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  Category,
  Channel,
  Collection,
  Page,
  ProductFilters,
  ProductSummary,
  SavedView,
} from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  ForbiddenState,
  PageHeader,
  SelectField,
  StatusBadge,
  TextField,
  errorMessage,
  formatDateTime,
  useCursorPagination,
  useToast,
} from '@uc/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTenant, useTenantQuery } from '../../../../lib/tenant';

const SORTS = [
  { value: '-updatedAt', label: 'Recently updated' },
  { value: 'title', label: 'Title A→Z' },
  { value: '-title', label: 'Title Z→A' },
  { value: '-createdAt', label: 'Newest' },
  { value: 'createdAt', label: 'Oldest' },
];
const EMPTY: ProductFilters = { sort: '-updatedAt' };

function SaveViewDialog({
  filters,
  onClose,
  onSaved,
}: {
  filters: ProductFilters;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { api, tenantId } = useTenant();
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [isShared, setShared] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api<SavedView>('/v1/admin/saved-views', {
        method: 'POST',
        body: { resource: 'products', name, filters, isShared },
      }),
    onSuccess: async (view) => {
      await qc.invalidateQueries({ queryKey: ['t', tenantId, 'saved-views'] });
      onSaved(view.id);
      toast('View saved');
      onClose();
    },
  });
  return (
    <Dialog
      open
      title="Save current filters as a view"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Save view
          </Button>
        </>
      }
    >
      <TextField label="View name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
      <Checkbox
        label="Share with all staff of this merchant"
        checked={isShared}
        onChange={(e) => setShared(e.target.checked)}
      />
      {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
    </Dialog>
  );
}

export default function ProductsPage() {
  const { can, tenantId, api } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const [filters, setFilters] = useState<ProductFilters>(EMPTY);
  const [q, setQ] = useState('');
  const [viewId, setViewId] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => ({ ...f, q: q || undefined })), 300);
    return () => clearTimeout(t);
  }, [q]);

  const pager = useCursorPagination(JSON.stringify(filters));
  const list = useTenantQuery<Page<ProductSummary>>(
    ['products'],
    '/v1/admin/products',
    { ...filters, cursor: pager.cursor, limit: 25 },
    can('catalog.read'),
  );
  const views = useTenantQuery<{ items: SavedView[] }>(
    ['saved-views'],
    '/v1/admin/saved-views',
    { resource: 'products' },
    can('catalog.read'),
  );
  const cats = useTenantQuery<{ items: Category[] }>(
    ['categories'],
    '/v1/admin/categories',
    undefined,
    can('catalog.read'),
  );
  const cols = useTenantQuery<Page<Collection>>(
    ['collections', 'all'],
    '/v1/admin/collections',
    { limit: 100 },
    can('catalog.read'),
  );
  const channels = useTenantQuery<Page<Channel>>(
    ['channels', 'all'],
    '/v1/admin/channels',
    { limit: 100 },
    can('stores.read'),
  );
  const removeView = useMutation({
    mutationFn: (id: string) => api(`/v1/admin/saved-views/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setViewId('');
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'saved-views'] });
      toast('View deleted');
    },
  });

  if (!can('catalog.read')) return <ForbiddenState />;
  const set = (patch: Partial<ProductFilters>) => {
    setViewId('');
    setFilters((f) => ({ ...f, ...patch }));
  };
  const applyView = (id: string) => {
    setViewId(id);
    const view = views.data?.items.find((v) => v.id === id);
    const next = view ? view.filters : EMPTY;
    setQ(next.q ?? '');
    setFilters(next);
  };
  const activeView = views.data?.items.find((v) => v.id === viewId);
  const filtered = JSON.stringify(filters) !== JSON.stringify(EMPTY);

  return (
    <>
      <PageHeader
        title="Products"
        description="Catalog content only — prices arrive with Pricing (Phase 06) and stock with Inventory (Phase 04)."
        actions={
          can('catalog.edit') && (
            <>
              <Link className="uc-btn" href={`/t/${tenantId}/products/import`}>
                Import CSV
              </Link>
              <Link className="uc-btn" data-variant="primary" href={`/t/${tenantId}/products/new`}>
                Add product
              </Link>
            </>
          )
        }
      />
      <Card>
        <div className="uc-filters" role="search">
          <SelectField
            label="Saved view"
            value={viewId}
            onChange={(e) => applyView(e.target.value)}
            options={[
              { value: '', label: 'All products' },
              ...(views.data?.items ?? []).map((v) => ({
                value: v.id,
                label: v.isOwn ? v.name : `${v.name} (shared by ${v.ownerEmail})`,
              })),
            ]}
          />
          <TextField
            label="Search"
            value={q}
            onChange={(e) => {
              setViewId('');
              setQ(e.target.value);
            }}
            placeholder="Title, brand, SKU or barcode"
          />
          <SelectField
            label="Status"
            value={filters.status ?? ''}
            onChange={(e) => set({ status: (e.target.value || undefined) as ProductFilters['status'] })}
            options={[
              { value: '', label: 'Any' },
              { value: 'draft', label: 'Draft' },
              { value: 'active', label: 'Active' },
              { value: 'archived', label: 'Archived' },
            ]}
          />
          <SelectField
            label="Category"
            value={filters.categoryId ?? ''}
            onChange={(e) => set({ categoryId: e.target.value || undefined })}
            options={[
              { value: '', label: 'Any' },
              ...(cats.data?.items ?? []).map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          <SelectField
            label="Collection"
            value={filters.collectionId ?? ''}
            onChange={(e) => set({ collectionId: e.target.value || undefined })}
            options={[
              { value: '', label: 'Any' },
              ...(cols.data?.items ?? []).map((c) => ({ value: c.id, label: c.title })),
            ]}
          />
          {channels.data && (
            <SelectField
              label="Published to"
              value={filters.channelId ?? ''}
              onChange={(e) => set({ channelId: e.target.value || undefined })}
              options={[
                { value: '', label: 'Any' },
                ...channels.data.items.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
          )}
          <SelectField
            label="Sort"
            value={filters.sort}
            onChange={(e) => set({ sort: e.target.value as ProductFilters['sort'] })}
            options={SORTS}
          />
        </div>
        <div className="uc-row">
          {filtered && !viewId && (
            <Button size="sm" onClick={() => setSaving(true)}>
              Save view
            </Button>
          )}
          {filtered && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setQ('');
                setViewId('');
                setFilters(EMPTY);
              }}
            >
              Clear filters
            </Button>
          )}
          {activeView?.isOwn && (
            <Button size="sm" variant="ghost" onClick={() => removeView.mutate(activeView.id)}>
              Delete view “{activeView.name}”
            </Button>
          )}
        </div>
        <DataTable
          caption="Products"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(p) => p.id}
          pagination={pager.controls(list.data?.nextCursor)}
          empty={
            <EmptyState
              title={filtered ? 'No products match these filters' : 'No products yet'}
              description={filtered ? undefined : 'Add your first product or import a CSV.'}
            />
          }
          columns={[
            {
              key: 'image',
              header: 'Image',
              render: (p) =>
                p.primaryMediaUrl ? (
                  <img
                    src={`/api${p.primaryMediaUrl}`}
                    alt=""
                    width={40}
                    height={40}
                    style={{ objectFit: 'cover', borderRadius: 4 }}
                  />
                ) : (
                  <span className="uc-muted">—</span>
                ),
            },
            {
              key: 'title',
              header: 'Product',
              render: (p) => (
                <>
                  <Link href={`/t/${tenantId}/products/${p.id}`}>{p.title}</Link>
                  {p.productType === 'jewellery' && (
                    <>
                      {' '}
                      <Badge tone="info">Jewellery</Badge>
                    </>
                  )}
                  <br />
                  <span className="uc-muted uc-mono">
                    {p.skus.join(', ')}
                    {p.variantCount > 3 ? ` +${p.variantCount - 3}` : ''}
                  </span>
                </>
              ),
            },
            { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
            {
              key: 'category',
              header: 'Category',
              render: (p) => p.categoryName ?? <span className="uc-muted">—</span>,
            },
            { key: 'variants', header: 'Variants', render: (p) => p.variantCount },
            {
              key: 'channels',
              header: 'Channels',
              render: (p) =>
                p.publishedChannels ? (
                  `${p.publishedChannels} published`
                ) : (
                  <span className="uc-muted">Not published</span>
                ),
            },
            { key: 'updated', header: 'Updated', render: (p) => formatDateTime(p.updatedAt) },
          ]}
        />
      </Card>
      {saving && <SaveViewDialog filters={filters} onClose={() => setSaving(false)} onSaved={setViewId} />}
    </>
  );
}
