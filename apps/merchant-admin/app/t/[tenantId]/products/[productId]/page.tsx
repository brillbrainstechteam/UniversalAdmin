'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  UpdateProductRequest,
  type AttributeDefinition,
  type Category,
  type Product,
  type ProductOption,
  type ProductStatus,
  type Variant,
} from '@uc/contracts';
import {
  Alert,
  apiUpload,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  SelectField,
  StatusBadge,
  TextField,
  errorMessage,
  formatDateTime,
  useToast,
  useUnsavedChangesWarning,
} from '@uc/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { serverErrors, validate } from '../../../../../lib/forms';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';
import { JewelleryCard } from './jewellery';

type Setter = (p: Product) => void;

function useProductMutation<TVars>(fn: (vars: TVars) => Promise<Product>, set: Setter, success: string) {
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (p) => {
      set(p);
      toast(success);
    },
  });
}

// ---------------------------------------------------------------- general + attributes

function GeneralCard({ product, set, readOnly }: { product: Product; set: Setter; readOnly: boolean }) {
  const { api, can } = useTenant();
  const cats = useTenantQuery<{ items: Category[] }>(['categories'], '/v1/admin/categories');
  const defs = useTenantQuery<{ items: AttributeDefinition[] }>(
    ['attributes'],
    '/v1/admin/attribute-definitions',
    undefined,
    can('catalog.read'),
  );
  const initial = () => ({
    title: product.title,
    slug: product.slug,
    brand: product.brand ?? '',
    categoryId: product.categoryId ?? '',
    description: product.description,
    tags: product.tags.join(', '),
    seoTitle: product.seo.title ?? '',
    seoDescription: product.seo.description ?? '',
    attributes: product.attributes,
  });
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => setForm(initial()), [product.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(form) !== JSON.stringify(initial());
  useUnsavedChangesWarning(dirty);
  const save = useMutation({
    mutationFn: (body: unknown) =>
      api<Product>(`/v1/admin/products/${product.id}`, { method: 'PATCH', body }),
    onSuccess: (p) => {
      setErrors({});
      setMessage(null);
      set(p);
    },
    onError: (e) => {
      const r = serverErrors(e);
      setErrors(r.fields);
      setMessage(r.message);
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    const body = {
      version: product.version,
      title: form.title,
      slug: form.slug,
      brand: form.brand || null,
      categoryId: form.categoryId || null,
      description: form.description,
      tags: form.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      seo: { title: form.seoTitle || null, description: form.seoDescription || null },
      attributes: Object.fromEntries(Object.entries(form.attributes).filter(([, v]) => v !== '')),
    };
    const check = validate(UpdateProductRequest, body);
    if (!check.ok) return setErrors(check.errors);
    save.mutate(body);
  }
  const s = (k: keyof ReturnType<typeof initial>) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const setAttr = (key: string, value: string | boolean) =>
    setForm((f) => ({ ...f, attributes: { ...f.attributes, [key]: value } }));
  return (
    <form onSubmit={submit} noValidate>
      <Card
        title="Details"
        actions={
          !readOnly && (
            <>
              <Button disabled={!dirty} onClick={() => setForm(initial())}>
                Discard
              </Button>
              <Button type="submit" variant="primary" disabled={!dirty} loading={save.isPending}>
                Save
              </Button>
            </>
          )
        }
      >
        {message && <Alert tone="danger">{message}</Alert>}
        <div className="uc-form-grid">
          <TextField
            label="Title"
            value={form.title}
            onChange={s('title')}
            error={errors.title}
            disabled={readOnly}
          />
          <TextField
            label="URL handle (slug)"
            value={form.slug}
            onChange={s('slug')}
            error={errors.slug}
            disabled={readOnly}
          />
          <TextField label="Brand" value={form.brand} onChange={s('brand')} disabled={readOnly} />
          <SelectField
            label="Category"
            value={form.categoryId}
            onChange={s('categoryId')}
            error={errors.categoryId}
            disabled={readOnly}
            options={[
              { value: '', label: 'None' },
              ...(cats.data?.items ?? []).map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          <TextField
            label="Tags (comma separated)"
            value={form.tags}
            onChange={s('tags')}
            disabled={readOnly}
          />
        </div>
        <div className="uc-field">
          <label htmlFor="desc">Description</label>
          <textarea
            id="desc"
            className="uc-textarea"
            rows={5}
            value={form.description}
            onChange={s('description')}
            disabled={readOnly}
            maxLength={20000}
          />
          <span className="uc-hint">Plain text; rendered escaped on storefronts.</span>
        </div>
        {defs.data && defs.data.items.length > 0 && (
          <fieldset className="uc-fieldset">
            <legend>Attributes</legend>
            <div className="uc-form-grid">
              {defs.data.items.map((d) => {
                const value = form.attributes[d.key];
                const error = errors[`attributes.${d.key}`];
                const label = `${d.label}${d.required ? ' *' : ''}`;
                if (d.type === 'select')
                  return (
                    <SelectField
                      key={d.key}
                      label={label}
                      value={String(value ?? '')}
                      error={error}
                      disabled={readOnly}
                      onChange={(e) => setAttr(d.key, e.target.value)}
                      options={[{ value: '', label: '—' }, ...d.options.map((o) => ({ value: o, label: o }))]}
                    />
                  );
                if (d.type === 'boolean')
                  return (
                    <SelectField
                      key={d.key}
                      label={label}
                      value={value === true ? 'true' : value === false ? 'false' : ''}
                      error={error}
                      disabled={readOnly}
                      onChange={(e) => setAttr(d.key, e.target.value === '' ? '' : e.target.value === 'true')}
                      options={[
                        { value: '', label: '—' },
                        { value: 'true', label: 'Yes' },
                        { value: 'false', label: 'No' },
                      ]}
                    />
                  );
                return (
                  <TextField
                    key={d.key}
                    label={label}
                    value={String(value ?? '')}
                    error={error}
                    disabled={readOnly}
                    inputMode={d.type === 'number' ? 'decimal' : undefined}
                    hint={d.type === 'number' ? 'Decimal, e.g. 18.5' : undefined}
                    onChange={(e) => setAttr(d.key, e.target.value)}
                  />
                );
              })}
            </div>
          </fieldset>
        )}
        <fieldset className="uc-fieldset">
          <legend>Search engine listing</legend>
          <div className="uc-form-grid">
            <TextField
              label="SEO title"
              value={form.seoTitle}
              onChange={s('seoTitle')}
              error={errors['seo.title']}
              maxLength={70}
              disabled={readOnly}
              hint={`${form.seoTitle.length}/70`}
            />
            <TextField
              label="SEO description"
              value={form.seoDescription}
              onChange={s('seoDescription')}
              error={errors['seo.description']}
              maxLength={320}
              disabled={readOnly}
              hint={`${form.seoDescription.length}/320`}
            />
          </div>
        </fieldset>
      </Card>
    </form>
  );
}

// ---------------------------------------------------------------- options

function OptionsCard({ product, set, readOnly }: { product: Product; set: Setter; readOnly: boolean }) {
  const { api } = useTenant();
  const toText = (o: ProductOption[]) => o.map((x) => ({ name: x.name, values: x.values.join(', ') }));
  const [rows, setRows] = useState(toText(product.options));
  useEffect(() => setRows(toText(product.options)), [product.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useProductMutation(
    (options: ProductOption[]) =>
      api<Product>(`/v1/admin/products/${product.id}`, {
        method: 'PATCH',
        body: { version: product.version, options },
      }),
    set,
    'Options saved',
  );
  const parsed = rows
    .filter((r) => r.name.trim())
    .map((r) => ({
      name: r.name.trim(),
      values: r.values
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    }));
  const dirty = JSON.stringify(parsed) !== JSON.stringify(product.options);
  return (
    <Card
      title="Options"
      actions={
        !readOnly && (
          <Button
            variant="primary"
            disabled={!dirty}
            loading={save.isPending}
            onClick={() => save.mutate(parsed)}
          >
            Save options
          </Button>
        )
      }
    >
      <p className="uc-muted" style={{ margin: 0 }}>
        Up to 3 axes such as Size or Colour. Values are comma separated. Removing a value that a variant uses
        is rejected.
      </p>
      {rows.map((r, i) => (
        <div key={i} className="uc-form-grid">
          <TextField
            label={`Option ${i + 1} name`}
            value={r.name}
            disabled={readOnly}
            onChange={(e) =>
              setRows((rs) => rs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
            }
          />
          <TextField
            label={`Option ${i + 1} values`}
            value={r.values}
            disabled={readOnly}
            onChange={(e) =>
              setRows((rs) => rs.map((x, j) => (j === i ? { ...x, values: e.target.value } : x)))
            }
          />
        </div>
      ))}
      {!readOnly && rows.length < 3 && (
        <Button
          size="sm"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => setRows((rs) => [...rs, { name: '', values: '' }])}
        >
          Add option
        </Button>
      )}
      {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
    </Card>
  );
}

// ---------------------------------------------------------------- variants

function VariantDialog({
  product,
  variant,
  set,
  onClose,
}: {
  product: Product;
  variant: Variant | 'new';
  set: Setter;
  onClose: () => void;
}) {
  const { api } = useTenant();
  const isNew = variant === 'new';
  const v = isNew ? null : variant;
  const [form, setForm] = useState({
    sku: v?.sku ?? '',
    barcode: v?.barcode ?? '',
    title: v?.title ?? '',
    status: v?.status ?? 'active',
    optionValues:
      v?.optionValues ?? Object.fromEntries(product.options.map((o) => [o.name, o.values[0] ?? ''])),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        sku: form.sku,
        barcode: form.barcode || null,
        title: form.title || undefined,
        status: form.status,
        optionValues: form.optionValues,
      };
      return isNew
        ? api<Product>(`/v1/admin/products/${product.id}/variants`, { method: 'POST', body })
        : api<Product>(`/v1/admin/products/${product.id}/variants/${v!.id}`, {
            method: 'PATCH',
            body: { ...body, version: v!.version },
          });
    },
    onSuccess: (p) => {
      set(p);
      onClose();
    },
    onError: (e) => {
      const r = serverErrors(e);
      setErrors(r.fields);
      setMessage(r.message);
    },
  });
  return (
    <Dialog
      open
      title={isNew ? 'Add variant' : `Edit ${v!.sku}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="uc-form-grid">
        <TextField
          label="SKU"
          value={form.sku}
          error={errors.sku}
          onChange={(e) => setForm({ ...form, sku: e.target.value })}
        />
        <TextField
          label="Barcode"
          value={form.barcode}
          error={errors.barcode}
          onChange={(e) => setForm({ ...form, barcode: e.target.value })}
        />
        <TextField
          label="Variant title"
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          hint="Defaults to option values"
        />
        <SelectField
          label="Status"
          value={form.status}
          onChange={(e) => setForm({ ...form, status: e.target.value as 'active' | 'inactive' })}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
          ]}
        />
        {product.options.map((o) => (
          <SelectField
            key={o.name}
            label={o.name}
            value={form.optionValues[o.name] ?? ''}
            error={errors[`optionValues.${o.name}`] ?? errors.optionValues}
            onChange={(e) =>
              setForm({ ...form, optionValues: { ...form.optionValues, [o.name]: e.target.value } })
            }
            options={o.values.map((x) => ({ value: x, label: x }))}
          />
        ))}
      </div>
      {message && <Alert tone="danger">{message}</Alert>}
    </Dialog>
  );
}

// ---------------------------------------------------------------- media

function MediaCard({ product, set, readOnly }: { product: Product; set: Setter; readOnly: boolean }) {
  const { api, tenantId } = useTenant();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState(product.media.map((m) => ({ mediaId: m.id, altText: m.altText })));
  useEffect(() => setItems(product.media.map((m) => ({ mediaId: m.id, altText: m.altText }))), [product]);
  const upload = useMutation({
    mutationFn: (file: File) => apiUpload<Product>(`/v1/admin/products/${product.id}/media`, file, tenantId),
    onSuccess: (p) => {
      set(p);
      toast('Image uploaded');
    },
  });
  const order = useProductMutation(
    () => api<Product>(`/v1/admin/products/${product.id}/media`, { method: 'PATCH', body: { items } }),
    set,
    'Gallery saved',
  );
  const remove = useProductMutation(
    (mediaId: string) =>
      api<Product>(`/v1/admin/products/${product.id}/media/${mediaId}`, { method: 'DELETE' }),
    set,
    'Image removed',
  );
  const byId = new Map(product.media.map((m) => [m.id, m]));
  const dirty =
    JSON.stringify(items) !==
    JSON.stringify(product.media.map((m) => ({ mediaId: m.id, altText: m.altText })));
  const move = (i: number, d: number) =>
    setItems((xs) => {
      const next = [...xs];
      const [x] = next.splice(i, 1);
      next.splice(i + d, 0, x!);
      return next;
    });
  return (
    <Card
      title="Images"
      actions={
        !readOnly && (
          <>
            <input
              ref={input}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              hidden
              aria-label="Upload image"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload.mutate(f);
                e.target.value = '';
              }}
            />
            <Button loading={upload.isPending} onClick={() => input.current?.click()}>
              Upload image
            </Button>
            <Button
              variant="primary"
              disabled={!dirty}
              loading={order.isPending}
              onClick={() => order.mutate(undefined)}
            >
              Save gallery
            </Button>
          </>
        )
      }
    >
      <span className="uc-muted">
        JPEG, PNG, WebP or GIF up to 10 MB. The first image is the primary image.
      </span>
      {upload.error && <Alert tone="danger">{errorMessage(upload.error)}</Alert>}
      {items.length === 0 ? (
        <EmptyState title="No images yet" />
      ) : (
        <ul className="uc-stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {items.map((item, i) => {
            const m = byId.get(item.mediaId);
            if (!m) return null;
            return (
              <li key={item.mediaId} className="uc-row" style={{ alignItems: 'flex-end' }}>
                <img
                  src={`/api${m.url}`}
                  alt={item.altText || m.filename}
                  width={72}
                  height={72}
                  style={{ objectFit: 'cover', borderRadius: 6, border: '1px solid var(--uc-border)' }}
                />
                <TextField
                  label={`Alt text for ${m.filename}`}
                  value={item.altText}
                  disabled={readOnly}
                  maxLength={250}
                  onChange={(e) =>
                    setItems((xs) => xs.map((x, j) => (j === i ? { ...x, altText: e.target.value } : x)))
                  }
                />
                {!readOnly && (
                  <>
                    <Button
                      size="sm"
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                      aria-label={`Move ${m.filename} up`}
                    >
                      ↑
                    </Button>
                    <Button
                      size="sm"
                      disabled={i === items.length - 1}
                      onClick={() => move(i, 1)}
                      aria-label={`Move ${m.filename} down`}
                    >
                      ↓
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      loading={remove.isPending}
                      onClick={() => remove.mutate(m.id)}
                    >
                      Remove<span className="uc-sr-only"> {m.filename}</span>
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- page

export default function ProductPage() {
  const { productId } = useParams<{ productId: string }>();
  const { can, api, tenantId } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const product = useTenantQuery<Product>(
    ['products', productId],
    `/v1/admin/products/${productId}`,
    undefined,
    can('catalog.read'),
  );
  const [variant, setVariant] = useState<Variant | 'new' | null>(null);
  const [statusTarget, setStatusTarget] = useState<ProductStatus | null>(null);
  const set: Setter = (p) => {
    qc.setQueryData(['t', tenantId, 'products', productId, {}], p);
    void qc.invalidateQueries({ queryKey: ['t', tenantId, 'products'], exact: false, refetchType: 'none' });
  };
  const status = useMutation({
    mutationFn: (s: ProductStatus) =>
      api<Product>(`/v1/admin/products/${productId}`, {
        method: 'PATCH',
        body: { version: product.data!.version, status: s },
      }),
    onSuccess: (p) => {
      set(p);
      setStatusTarget(null);
      toast(`Product is now ${p.status}`);
    },
  });
  const publication = useMutation({
    mutationFn: ({ channelId, publish }: { channelId: string; publish: boolean }) =>
      api(`/v1/admin/products/${productId}/publications/${channelId}`, {
        method: publish ? 'PUT' : 'DELETE',
      }),
    onSuccess: () => void product.refetch(),
  });

  if (!can('catalog.read')) return <ForbiddenState />;
  if (product.error) return <ErrorState error={product.error} onRetry={() => void product.refetch()} />;
  if (!product.data) return <LoadingState />;
  const p = product.data;
  const readOnly = !can('catalog.edit') || p.status === 'archived';
  const transitions: { to: ProductStatus; label: string; tone: 'primary' | 'danger' | 'default' }[] =
    p.status === 'draft'
      ? [
          { to: 'active', label: 'Activate', tone: 'primary' },
          { to: 'archived', label: 'Archive', tone: 'danger' },
        ]
      : p.status === 'active'
        ? [
            { to: 'draft', label: 'Set to draft', tone: 'default' },
            { to: 'archived', label: 'Archive', tone: 'danger' },
          ]
        : [{ to: 'draft', label: 'Restore to draft', tone: 'primary' }];

  return (
    <>
      <PageHeader
        title={p.title}
        description={
          <>
            <Link href={`/t/${tenantId}/products`}>Products</Link> · <span className="uc-mono">{p.slug}</span>{' '}
            · updated {formatDateTime(p.updatedAt)}
          </>
        }
        actions={
          <>
            {p.productType === 'jewellery' && <Badge tone="info">Jewellery</Badge>}
            <StatusBadge status={p.status} />
            {can('catalog.edit') &&
              transitions.map((t) => (
                <Button key={t.to} variant={t.tone} onClick={() => setStatusTarget(t.to)}>
                  {t.label}
                </Button>
              ))}
          </>
        }
      />
      {p.status === 'archived' && (
        <Alert tone="warning">
          Archived products are read-only and unpublished everywhere. Restore to draft to edit.
        </Alert>
      )}
      {status.error && <Alert tone="danger">{errorMessage(status.error)}</Alert>}
      <GeneralCard product={p} set={set} readOnly={readOnly} />
      <OptionsCard product={p} set={set} readOnly={readOnly} />
      <Card
        title="Variants"
        actions={
          !readOnly && (
            <Button
              variant="primary"
              onClick={() => setVariant('new')}
              disabled={p.options.length === 0 && p.variants.length >= 1}
              title={p.options.length === 0 ? 'Add an option first' : undefined}
            >
              Add variant
            </Button>
          )
        }
      >
        {p.options.length === 0 && (
          <span className="uc-muted">Add an option (e.g. Size) to create more than one variant.</span>
        )}
        <DataTable
          caption="Variants"
          rows={p.variants}
          rowKey={(v) => v.id}
          empty={<EmptyState title="No variants" />}
          columns={[
            { key: 'sku', header: 'SKU', render: (v) => <span className="uc-mono">{v.sku}</span> },
            { key: 'title', header: 'Title', render: (v) => v.title || '—' },
            {
              key: 'options',
              header: 'Options',
              render: (v) =>
                Object.entries(v.optionValues)
                  .map(([k, x]) => `${k}: ${x}`)
                  .join(', ') || '—',
            },
            { key: 'barcode', header: 'Barcode', render: (v) => v.barcode ?? '—' },
            { key: 'status', header: 'Status', render: (v) => <StatusBadge status={v.status} /> },
            {
              key: 'actions',
              header: 'Actions',
              render: (v) =>
                !readOnly ? (
                  <Button size="sm" onClick={() => setVariant(v)}>
                    Edit<span className="uc-sr-only"> {v.sku}</span>
                  </Button>
                ) : null,
            },
          ]}
        />
      </Card>
      <JewelleryCard product={p} />
      <MediaCard product={p} set={set} readOnly={readOnly} />
      <Card title="Sales channels">
        <span className="uc-muted">
          Only active products can be published. Storefronts show active, published products with at least one
          active variant.
        </span>
        {publication.error && <Alert tone="danger">{errorMessage(publication.error)}</Alert>}
        <DataTable
          caption="Channel publication"
          rows={p.publications}
          rowKey={(c) => c.channelId}
          empty={<EmptyState title="No channels" />}
          columns={[
            {
              key: 'channel',
              header: 'Channel',
              render: (c) => `${c.channelName} (${c.channelType.replace('_', ' ')})`,
            },
            { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
            {
              key: 'since',
              header: 'Published',
              render: (c) => (c.publishedAt ? formatDateTime(c.publishedAt) : '—'),
            },
            {
              key: 'action',
              header: 'Action',
              render: (c) =>
                can('catalog.publish') ? (
                  c.status === 'published' ? (
                    <Button
                      size="sm"
                      loading={publication.isPending}
                      onClick={() => publication.mutate({ channelId: c.channelId, publish: false })}
                    >
                      Unpublish<span className="uc-sr-only"> from {c.channelName}</span>
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={p.status !== 'active'}
                      loading={publication.isPending}
                      onClick={() => publication.mutate({ channelId: c.channelId, publish: true })}
                    >
                      Publish<span className="uc-sr-only"> to {c.channelName}</span>
                    </Button>
                  )
                ) : null,
            },
          ]}
        />
      </Card>
      {variant && <VariantDialog product={p} variant={variant} set={set} onClose={() => setVariant(null)} />}
      <ConfirmDialog
        open={statusTarget !== null}
        title={`Change status to ${statusTarget ?? ''}?`}
        description={
          statusTarget === 'archived'
            ? 'Archiving unpublishes the product from every channel.'
            : statusTarget === 'draft'
              ? 'Draft products disappear from storefronts but keep their channel settings.'
              : 'The product becomes eligible for publishing.'
        }
        confirmLabel="Confirm"
        tone={statusTarget === 'archived' ? 'danger' : 'primary'}
        loading={status.isPending}
        error={status.error ? errorMessage(status.error) : null}
        onConfirm={() => statusTarget && status.mutate(statusTarget)}
        onClose={() => setStatusTarget(null)}
      />
    </>
  );
}
