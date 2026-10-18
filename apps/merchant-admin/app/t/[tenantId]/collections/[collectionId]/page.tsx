'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CollectionDetail, Page, ProductSummary } from '@uc/contracts';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  SelectField,
  StatusBadge,
  TextField,
  errorMessage,
  useToast,
  useUnsavedChangesWarning,
} from '@uc/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { serverErrors } from '../../../../../lib/forms';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

export default function CollectionPage() {
  const { collectionId } = useParams<{ collectionId: string }>();
  const { can, api, tenantId } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const col = useTenantQuery<CollectionDetail>(
    ['collections', collectionId],
    `/v1/admin/collections/${collectionId}`,
    undefined,
    can('catalog.read'),
  );
  const [fields, setFields] = useState({
    title: '',
    description: '',
    status: 'active' as 'active' | 'inactive',
  });
  const [members, setMembers] = useState<{ id: string; title: string; status: string }[]>([]);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (col.data) {
      setFields({ title: col.data.title, description: col.data.description, status: col.data.status });
      setMembers(col.data.products);
    }
  }, [col.data]);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  const results = useTenantQuery<Page<ProductSummary>>(
    ['products', 'picker'],
    '/v1/admin/products',
    { q: debounced, limit: 10 },
    Boolean(debounced),
  );
  const setData = (c: CollectionDetail) => {
    qc.setQueryData(['t', tenantId, 'collections', collectionId, {}], c);
    void qc.invalidateQueries({ queryKey: ['t', tenantId, 'collections'], refetchType: 'none' });
  };
  const saveFields = useMutation({
    mutationFn: () =>
      api<CollectionDetail>(`/v1/admin/collections/${collectionId}`, {
        method: 'PATCH',
        body: { version: col.data!.version, ...fields },
      }),
    onSuccess: (c) => {
      setData(c);
      toast('Collection saved');
    },
    onError: (e) => setErrors(serverErrors(e).fields),
  });
  const saveMembers = useMutation({
    mutationFn: () =>
      api<CollectionDetail>(`/v1/admin/collections/${collectionId}/products`, {
        method: 'PUT',
        body: { version: col.data!.version, productIds: members.map((m) => m.id) },
      }),
    onSuccess: (c) => {
      setData(c);
      toast('Products saved');
    },
  });
  const fieldsDirty =
    !!col.data &&
    JSON.stringify(fields) !==
      JSON.stringify({ title: col.data.title, description: col.data.description, status: col.data.status });
  const membersDirty =
    !!col.data &&
    JSON.stringify(members.map((m) => m.id)) !== JSON.stringify(col.data.products.map((m) => m.id));
  useUnsavedChangesWarning(fieldsDirty || membersDirty);

  if (!can('catalog.read')) return <ForbiddenState />;
  if (col.error) return <ErrorState error={col.error} onRetry={() => void col.refetch()} />;
  if (!col.data) return <LoadingState />;
  const readOnly = !can('catalog.edit');
  const move = (i: number, d: number) =>
    setMembers((xs) => {
      const next = [...xs];
      const [x] = next.splice(i, 1);
      next.splice(i + d, 0, x!);
      return next;
    });

  return (
    <>
      <PageHeader
        title={col.data.title}
        description={
          <>
            <Link href={`/t/${tenantId}/collections`}>Collections</Link> ·{' '}
            <span className="uc-mono">{col.data.slug}</span>
          </>
        }
      />
      <Card
        title="Details"
        actions={
          !readOnly && (
            <Button
              variant="primary"
              disabled={!fieldsDirty}
              loading={saveFields.isPending}
              onClick={() => saveFields.mutate()}
            >
              Save
            </Button>
          )
        }
      >
        <div className="uc-form-grid">
          <TextField
            label="Title"
            value={fields.title}
            error={errors.title}
            disabled={readOnly}
            onChange={(e) => setFields({ ...fields, title: e.target.value })}
          />
          <SelectField
            label="Status"
            value={fields.status}
            disabled={readOnly}
            onChange={(e) => setFields({ ...fields, status: e.target.value as 'active' | 'inactive' })}
            options={[
              { value: 'active', label: 'Active (visible on storefronts)' },
              { value: 'inactive', label: 'Inactive' },
            ]}
          />
        </div>
        <div className="uc-field">
          <label htmlFor="col-desc">Description</label>
          <textarea
            id="col-desc"
            className="uc-textarea"
            rows={3}
            value={fields.description}
            disabled={readOnly}
            onChange={(e) => setFields({ ...fields, description: e.target.value })}
          />
        </div>
        {saveFields.error && <Alert tone="danger">{errorMessage(saveFields.error)}</Alert>}
      </Card>
      <Card
        title={`Products (${members.length})`}
        actions={
          !readOnly && (
            <Button
              variant="primary"
              disabled={!membersDirty}
              loading={saveMembers.isPending}
              onClick={() => saveMembers.mutate()}
            >
              Save products
            </Button>
          )
        }
      >
        {!readOnly && (
          <div className="uc-stack">
            <TextField
              label="Add products"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by title or SKU"
            />
            {debounced && (
              <ul className="uc-stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {(results.data?.items ?? [])
                  .filter((r) => !members.some((m) => m.id === r.id))
                  .map((r) => (
                    <li key={r.id} className="uc-row">
                      <Button
                        size="sm"
                        onClick={() =>
                          setMembers((m) => [...m, { id: r.id, title: r.title, status: r.status }])
                        }
                      >
                        Add<span className="uc-sr-only"> {r.title}</span>
                      </Button>
                      {r.title} <StatusBadge status={r.status} />
                    </li>
                  ))}
                {results.data && results.data.items.length === 0 && (
                  <li className="uc-muted">No products found</li>
                )}
              </ul>
            )}
          </div>
        )}
        {saveMembers.error && <Alert tone="danger">{errorMessage(saveMembers.error)}</Alert>}
        {members.length === 0 ? (
          <EmptyState title="No products in this collection" />
        ) : (
          <ol className="uc-stack" style={{ margin: 0, paddingLeft: 20 }}>
            {members.map((m, i) => (
              <li key={m.id}>
                <span className="uc-row">
                  <Link href={`/t/${tenantId}/products/${m.id}`}>{m.title}</Link>{' '}
                  <StatusBadge status={m.status} />
                  {!readOnly && (
                    <>
                      <Button
                        size="sm"
                        disabled={i === 0}
                        onClick={() => move(i, -1)}
                        aria-label={`Move ${m.title} up`}
                      >
                        ↑
                      </Button>
                      <Button
                        size="sm"
                        disabled={i === members.length - 1}
                        onClick={() => move(i, 1)}
                        aria-label={`Move ${m.title} down`}
                      >
                        ↓
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setMembers((xs) => xs.filter((x) => x.id !== m.id))}
                      >
                        Remove<span className="uc-sr-only"> {m.title}</span>
                      </Button>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}
