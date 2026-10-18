'use client';

import { useMutation } from '@tanstack/react-query';
import { CreateProductRequest, slugify, type Category, type Product } from '@uc/contracts';
import {
  Alert,
  Button,
  Card,
  ForbiddenState,
  PageHeader,
  SelectField,
  TextField,
  useToast,
  useUnsavedChangesWarning,
} from '@uc/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { serverErrors, validate } from '../../../../../lib/forms';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

export default function NewProductPage() {
  const { can, api, tenantId, context } = useTenant();
  const router = useRouter();
  const toast = useToast();
  const cats = useTenantQuery<{ items: Category[] }>(
    ['categories'],
    '/v1/admin/categories',
    undefined,
    can('catalog.read'),
  );
  const [form, setForm] = useState({
    title: '',
    slug: '',
    productType: 'standard',
    brand: '',
    categoryId: '',
    sku: '',
    barcode: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const dirty = Object.values(form).some((v) => v && v !== 'standard');
  const create = useMutation({
    mutationFn: (body: unknown) => api<Product>('/v1/admin/products', { method: 'POST', body }),
    onSuccess: (p) => {
      toast('Product created as draft');
      router.push(`/t/${tenantId}/products/${p.id}`);
    },
    onError: (e) => {
      const r = serverErrors(e);
      // Map nested variant errors onto the single SKU field shown here.
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(r.fields))
        fields[k.startsWith('variants') || k === 'sku' ? 'sku' : k] = v;
      if (r.fields.barcode) fields.barcode = r.fields.barcode;
      setErrors(fields);
      setMessage(r.message);
    },
  });
  useUnsavedChangesWarning(dirty && !create.isSuccess);

  if (!can('catalog.edit')) return <ForbiddenState />;
  const jewellery = context.features.includes('jewellery');
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    const body = {
      title: form.title,
      slug: form.slug || undefined,
      productType: form.productType,
      brand: form.brand || null,
      categoryId: form.categoryId || null,
      variants: [{ sku: form.sku, barcode: form.barcode || null }],
    };
    const check = validate(CreateProductRequest, body);
    if (!check.ok) {
      const e = { ...check.errors };
      if (e['variants.0.sku']) e.sku = e['variants.0.sku'];
      if (e['variants.0.barcode']) e.barcode = e['variants.0.barcode'];
      return setErrors(e);
    }
    setErrors({});
    create.mutate(body);
  }

  return (
    <>
      <PageHeader
        title="Add product"
        description={<Link href={`/t/${tenantId}/products`}>Back to products</Link>}
      />
      <form onSubmit={submit} noValidate className="uc-stack">
        <Card title="Basics">
          <div className="uc-form-grid">
            <TextField
              label="Title"
              value={form.title}
              onChange={set('title')}
              error={errors.title}
              required
            />
            <TextField
              label="URL handle (slug)"
              value={form.slug}
              onChange={set('slug')}
              error={errors.slug}
              placeholder={slugify(form.title) || 'auto from title'}
              hint="Leave empty to derive from the title"
            />
            {jewellery && (
              <SelectField
                label="Product type"
                value={form.productType}
                onChange={set('productType')}
                options={[
                  { value: 'standard', label: 'Standard' },
                  { value: 'jewellery', label: 'Jewellery (measurements in Phase 03)' },
                ]}
              />
            )}
            <TextField label="Brand" value={form.brand} onChange={set('brand')} />
            <SelectField
              label="Category"
              value={form.categoryId}
              onChange={set('categoryId')}
              error={errors.categoryId}
              options={[
                { value: '', label: 'None' },
                ...(cats.data?.items ?? []).map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
          </div>
        </Card>
        <Card title="First variant">
          <p className="uc-muted" style={{ margin: 0 }}>
            Every product has at least one SKU. Add options (size, colour…) and more variants after creating
            it.
          </p>
          <div className="uc-form-grid">
            <TextField label="SKU" value={form.sku} onChange={set('sku')} error={errors.sku} required />
            <TextField
              label="Barcode (optional)"
              value={form.barcode}
              onChange={set('barcode')}
              error={errors.barcode}
            />
          </div>
        </Card>
        {message && <Alert tone="danger">{message}</Alert>}
        <div className="uc-row">
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create draft
          </Button>
          <Link className="uc-btn" href={`/t/${tenantId}/products`}>
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}
