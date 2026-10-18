'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CreateCategoryRequest, type Category } from '@uc/contracts';
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  ForbiddenState,
  PageHeader,
  SelectField,
  TextField,
  errorMessage,
  useToast,
} from '@uc/ui';
import { useState } from 'react';
import { serverErrors, validate } from '../../../../lib/forms';
import { useTenant, useTenantQuery } from '../../../../lib/tenant';

function depthOf(c: Category, byId: Map<string, Category>): number {
  let d = 0;
  for (let p = c.parentId; p && d < 20; p = byId.get(p)?.parentId ?? null) d++;
  return d;
}

function CategoryDialog({
  category,
  all,
  onClose,
}: {
  category: Category | 'new';
  all: Category[];
  onClose: () => void;
}) {
  const { api, tenantId } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const isNew = category === 'new';
  const c = isNew ? null : category;
  const [form, setForm] = useState({
    name: c?.name ?? '',
    slug: c?.slug ?? '',
    parentId: c?.parentId ?? '',
    position: String(c?.position ?? 0),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) =>
      isNew
        ? api('/v1/admin/categories', { method: 'POST', body })
        : api(`/v1/admin/categories/${c!.id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'categories'] });
      toast(isNew ? 'Category created' : 'Category saved');
      onClose();
    },
    onError: (e) => {
      const r = serverErrors(e);
      setErrors(r.fields);
      setMessage(r.message);
    },
  });
  function submit() {
    const body = {
      name: form.name,
      slug: form.slug || undefined,
      parentId: form.parentId || null,
      position: Number(form.position) || 0,
    };
    if (isNew) {
      const check = validate(CreateCategoryRequest, body);
      if (!check.ok) return setErrors(check.errors);
      save.mutate(body);
    } else save.mutate({ ...body, version: c!.version });
  }
  return (
    <Dialog
      open
      title={isNew ? 'New category' : `Edit ${c!.name}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <TextField
        label="Name"
        value={form.name}
        error={errors.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
      />
      <TextField
        label="URL handle"
        value={form.slug}
        error={errors.slug}
        onChange={(e) => setForm({ ...form, slug: e.target.value })}
        hint="Leave empty to derive from the name"
      />
      <SelectField
        label="Parent"
        value={form.parentId}
        error={errors.parentId}
        onChange={(e) => setForm({ ...form, parentId: e.target.value })}
        options={[
          { value: '', label: 'None (top level)' },
          ...all.filter((x) => x.id !== c?.id).map((x) => ({ value: x.id, label: x.name })),
        ]}
      />
      <TextField
        label="Sort position"
        type="number"
        min={0}
        value={form.position}
        onChange={(e) => setForm({ ...form, position: e.target.value })}
      />
      {message && <Alert tone="danger">{message}</Alert>}
    </Dialog>
  );
}

export default function CategoriesPage() {
  const { can, api, tenantId } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useTenantQuery<{ items: Category[] }>(
    ['categories'],
    '/v1/admin/categories',
    undefined,
    can('catalog.read'),
  );
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Category | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api(`/v1/admin/categories/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'categories'] });
      toast('Category deleted');
      setDeleting(null);
    },
  });
  if (!can('catalog.read')) return <ForbiddenState />;
  const items = list.data?.items ?? [];
  const byId = new Map(items.map((c) => [c.id, c]));
  const manage = can('catalog.edit');
  return (
    <>
      <PageHeader
        title="Categories"
        description="A tree used for storefront navigation and filtering. Each product has at most one primary category."
        actions={
          manage && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              New category
            </Button>
          )
        }
      />
      <Card>
        <DataTable
          caption="Categories"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(c) => c.id}
          empty={<EmptyState title="No categories yet" />}
          columns={[
            {
              key: 'name',
              header: 'Name',
              render: (c) => (
                <span style={{ paddingLeft: depthOf(c, byId) * 20 }}>
                  {depthOf(c, byId) > 0 ? '↳ ' : ''}
                  {c.name}
                </span>
              ),
            },
            { key: 'slug', header: 'Handle', render: (c) => <span className="uc-mono">{c.slug}</span> },
            { key: 'products', header: 'Products', render: (c) => c.productCount },
            {
              key: 'actions',
              header: 'Actions',
              render: (c) =>
                manage ? (
                  <span className="uc-row">
                    <Button size="sm" onClick={() => setEditing(c)}>
                      Edit<span className="uc-sr-only"> {c.name}</span>
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(c)}>
                      Delete<span className="uc-sr-only"> {c.name}</span>
                    </Button>
                  </span>
                ) : null,
            },
          ]}
        />
      </Card>
      {editing && <CategoryDialog category={editing} all={items} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? ''}?`}
        description="Only categories without sub-categories or products can be deleted."
        confirmLabel="Delete"
        loading={remove.isPending}
        error={remove.error ? errorMessage(remove.error) : null}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        onClose={() => {
          remove.reset();
          setDeleting(null);
        }}
      />
    </>
  );
}
