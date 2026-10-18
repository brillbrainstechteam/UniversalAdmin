'use client';

import { useMutation } from '@tanstack/react-query';
import { CreateCollectionRequest, type Collection, type Page } from '@uc/contracts';
import {
  Alert,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  ForbiddenState,
  PageHeader,
  StatusBadge,
  TextField,
  useCursorPagination,
  useToast,
} from '@uc/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { serverErrors, validate } from '../../../../lib/forms';
import { useTenant, useTenantQuery } from '../../../../lib/tenant';

function CreateDialog({ onClose }: { onClose: () => void }) {
  const { api, tenantId } = useTenant();
  const router = useRouter();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: unknown) => api<Collection>('/v1/admin/collections', { method: 'POST', body }),
    onSuccess: (c) => {
      toast('Collection created');
      router.push(`/t/${tenantId}/collections/${c.id}`);
    },
    onError: (e) => {
      const r = serverErrors(e);
      setErrors(r.fields);
      setMessage(r.message);
    },
  });
  function submit() {
    const body = { title, slug: slug || undefined };
    const check = validate(CreateCollectionRequest, body);
    if (!check.ok) return setErrors(check.errors);
    create.mutate(body);
  }
  return (
    <Dialog
      open
      title="New collection"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} onClick={submit}>
            Create
          </Button>
        </>
      }
    >
      <TextField
        label="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        error={errors.title}
      />
      <TextField
        label="URL handle (optional)"
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
        error={errors.slug}
      />
      {message && <Alert tone="danger">{message}</Alert>}
    </Dialog>
  );
}

export default function CollectionsPage() {
  const { can, tenantId } = useTenant();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const pager = useCursorPagination(debounced);
  const list = useTenantQuery<Page<Collection>>(
    ['collections'],
    '/v1/admin/collections',
    { q: debounced, cursor: pager.cursor, limit: 25 },
    can('catalog.read'),
  );
  if (!can('catalog.read')) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="Collections"
        description="Hand-picked, ordered groups of products for storefront merchandising."
        actions={
          can('catalog.edit') && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New collection
            </Button>
          )
        }
      />
      <Card>
        <div className="uc-filters" role="search">
          <TextField label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <DataTable
          caption="Collections"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(c) => c.id}
          pagination={pager.controls(list.data?.nextCursor)}
          empty={<EmptyState title={debounced ? 'No collections match' : 'No collections yet'} />}
          columns={[
            {
              key: 'title',
              header: 'Title',
              render: (c) => <Link href={`/t/${tenantId}/collections/${c.id}`}>{c.title}</Link>,
            },
            { key: 'slug', header: 'Handle', render: (c) => <span className="uc-mono">{c.slug}</span> },
            { key: 'count', header: 'Products', render: (c) => c.productCount },
            { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
          ]}
        />
      </Card>
      {creating && <CreateDialog onClose={() => setCreating(false)} />}
    </>
  );
}
