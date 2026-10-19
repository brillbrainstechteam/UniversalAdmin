'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PriceBook, PriceRule, PricingCatalogOptions, PricingItemResults } from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  SelectField,
  TextField,
  errorMessage,
  formatDateTime,
  useToast,
} from '@uc/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { serverErrors } from '../../../../../../lib/forms';
import { PricingTabs, majorMoney } from '../../../../../../lib/pricing';
import { useTenant, useTenantQuery } from '../../../../../../lib/tenant';

interface RuleSummary {
  id: string;
  name: string;
  status: 'draft_only' | 'published' | 'retired';
  priority: number;
  publishedVersion: number | null;
  hasDraft: boolean;
  baseKind: 'metal' | 'list_price';
}
interface ListPrice {
  variantId: string;
  sku: string;
  productTitle: string;
  amount: string;
  updatedAt: string;
}

function NewRuleDialog({ book, onClose }: { book: PriceBook; onClose: () => void }) {
  const { api, tenantId, context } = useTenant();
  const router = useRouter();
  const jewellery = context.features.includes('metal_rates');
  const [form, setForm] = useState({ name: '', priority: '0', base: jewellery ? 'metal' : 'list_price' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api<PriceRule>('/v1/admin/pricing/rules', {
        method: 'POST',
        body: {
          bookId: book.id,
          name: form.name,
          priority: /^\d{1,4}$/.test(form.priority) ? Number.parseInt(form.priority, 10) : -1,
          conditions: {},
          definition:
            form.base === 'metal'
              ? { base: { kind: 'metal', weightBasis: 'item' } }
              : { base: { kind: 'list_price' } },
        },
      }),
    onSuccess: (r) => router.push(`/t/${tenantId}/pricing/rules/${r.id}`),
    onError: (e) => {
      const r = serverErrors(e);
      setErrors(r.fields);
      setMessage(r.message);
    },
  });
  return (
    <Dialog
      open
      title="New price rule"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Create draft
          </Button>
        </>
      }
    >
      <div className="uc-form-grid">
        <TextField
          label="Name"
          value={form.name}
          error={errors.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <TextField
          label="Priority"
          inputMode="numeric"
          value={form.priority}
          error={errors.priority}
          onChange={(e) => setForm({ ...form, priority: e.target.value })}
        />
        <SelectField
          label="Price base"
          value={form.base}
          onChange={(e) => setForm({ ...form, base: e.target.value })}
          options={[
            ...(jewellery ? [{ value: 'metal', label: 'Metal value (weight × approved rate)' }] : []),
            { value: 'list_price', label: 'List price from this book' },
          ]}
        />
      </div>
      <span className="uc-muted">You will define conditions, charges and discounts on the next screen.</span>
      {message && <Alert tone="danger">{message}</Alert>}
    </Dialog>
  );
}

function BookSettings({ book }: { book: PriceBook }) {
  const { api, can, tenantId } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const options = useTenantQuery<PricingCatalogOptions>(['pricing', 'options'], '/v1/admin/pricing/options');
  const [form, setForm] = useState({
    name: book.name,
    channelId: book.channel?.id ?? '',
    priority: String(book.priority),
  });
  useEffect(
    () => setForm({ name: book.name, channelId: book.channel?.id ?? '', priority: String(book.priority) }),
    [book],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/v1/admin/pricing/books/${book.id}`, {
        method: 'PATCH',
        body: { version: book.version, ...body },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'pricing'] });
      setErrors({});
      toast('Price book saved');
    },
    onError: (e) => setErrors(serverErrors(e).fields),
  });
  const edit = can('pricing.edit');
  return (
    <Card
      title="Book"
      actions={
        edit && (
          <>
            <Button
              onClick={() => save.mutate({ status: book.status === 'active' ? 'archived' : 'active' })}
              loading={save.isPending}
            >
              {book.status === 'active' ? 'Archive' : 'Reactivate'}
            </Button>
            <Button
              variant="primary"
              loading={save.isPending}
              onClick={() =>
                save.mutate({
                  name: form.name,
                  channelId: form.channelId || null,
                  priority: /^\d{1,4}$/.test(form.priority) ? Number.parseInt(form.priority, 10) : -1,
                })
              }
            >
              Save
            </Button>
          </>
        )
      }
    >
      <div className="uc-form-grid">
        <TextField
          label="Name"
          value={form.name}
          disabled={!edit}
          error={errors.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <SelectField
          label="Channel"
          value={form.channelId}
          disabled={!edit}
          onChange={(e) => setForm({ ...form, channelId: e.target.value })}
          options={[
            { value: '', label: 'All channels' },
            ...(options.data?.channels ?? []).map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
        <TextField
          label="Priority"
          inputMode="numeric"
          value={form.priority}
          disabled={!edit}
          error={errors.priority}
          onChange={(e) => setForm({ ...form, priority: e.target.value })}
        />
      </div>
      <span className="uc-row">
        <Badge tone={book.status === 'active' ? 'success' : undefined}>{book.status}</Badge>
        <span className="uc-muted">Currency {book.currency}</span>
      </span>
      {save.error && Object.keys(errors).length === 0 && (
        <Alert tone="danger">{errorMessage(save.error)}</Alert>
      )}
    </Card>
  );
}

function ListPrices({ book }: { book: PriceBook }) {
  const { api, can, tenantId } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const prices = useTenantQuery<{ items: ListPrice[] }>(
    ['pricing', 'list-prices', book.id],
    `/v1/admin/pricing/books/${book.id}/list-prices`,
  );
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const found = useTenantQuery<PricingItemResults>(
    ['pricing', 'items'],
    '/v1/admin/pricing/items',
    { q: debounced },
    debounced.length > 0,
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (items: { variantId: string; amount: string | null }[]) =>
      api(`/v1/admin/pricing/books/${book.id}/list-prices`, { method: 'PUT', body: { items } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'pricing'] });
      setDrafts({});
      setErrors(null);
      toast('List prices saved');
    },
    onError: (e) => setErrors(errorMessage(e)),
  });
  const edit = can('pricing.edit') && book.status === 'active';
  const variantsOnly = (found.data?.items ?? []).filter((i) => !i.serialItemId);
  return (
    <Card
      title="List prices"
      actions={
        edit &&
        Object.keys(drafts).length > 0 && (
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                Object.entries(drafts).map(([variantId, amount]) => ({
                  variantId,
                  amount: amount.trim() === '' ? null : amount.trim(),
                })),
              )
            }
          >
            Save {Object.keys(drafts).length} change(s)
          </Button>
        )
      }
    >
      <span className="uc-muted">
        Used by rules whose base is &quot;list price&quot;. Amounts are per piece in {book.currency}. Clear an
        amount to remove it.
      </span>
      <DataTable
        caption="List prices"
        rows={prices.data?.items}
        isLoading={prices.isLoading}
        error={prices.error}
        rowKey={(p) => p.variantId}
        empty={<EmptyState title="No list prices" />}
        columns={[
          { key: 'sku', header: 'SKU', render: (p) => <span className="uc-mono">{p.sku}</span> },
          { key: 'title', header: 'Product', render: (p) => p.productTitle },
          {
            key: 'amount',
            header: 'Amount',
            render: (p) =>
              edit ? (
                <TextField
                  label={`Price for ${p.sku}`}
                  inputMode="decimal"
                  value={drafts[p.variantId] ?? p.amount.replace(/0+$/, '').replace(/\.$/, '')}
                  onChange={(e) => setDrafts({ ...drafts, [p.variantId]: e.target.value })}
                />
              ) : (
                majorMoney(p.amount, book.currency)
              ),
          },
        ]}
      />
      {edit && (
        <div className="uc-stack">
          <TextField
            label="Add a variant (search SKU or title)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {variantsOnly
            .filter((v) => !prices.data?.items.some((p) => p.variantId === v.variantId))
            .slice(0, 8)
            .map((v) => (
              <div key={v.variantId} className="uc-row">
                <span className="uc-mono">{v.sku}</span> {v.title}
                <TextField
                  label={`New price for ${v.sku}`}
                  inputMode="decimal"
                  value={drafts[v.variantId] ?? ''}
                  onChange={(e) => setDrafts({ ...drafts, [v.variantId]: e.target.value })}
                />
              </div>
            ))}
        </div>
      )}
      {errors && <Alert tone="danger">{errors}</Alert>}
    </Card>
  );
}

export default function PriceBookPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const { can, tenantId, context } = useTenant();
  const enabled = can('pricing.read') && context.features.includes('pricing');
  const book = useTenantQuery<PriceBook>(
    ['pricing', 'book', bookId],
    `/v1/admin/pricing/books/${bookId}`,
    undefined,
    enabled,
  );
  const rules = useTenantQuery<{ items: RuleSummary[] }>(
    ['pricing', 'rules', bookId],
    `/v1/admin/pricing/books/${bookId}/rules`,
    undefined,
    enabled,
  );
  const [creating, setCreating] = useState(false);
  if (!enabled) return <ForbiddenState />;
  if (book.error) return <ErrorState error={book.error} onRetry={() => void book.refetch()} />;
  if (!book.data) return <LoadingState />;
  const b = book.data;
  return (
    <>
      <PageHeader
        title={b.name}
        description={`${b.channel ? `Channel ${b.channel.name}` : 'All channels'} · priority ${b.priority} · updated ${formatDateTime(b.updatedAt, context.tenant.timezone)}`}
        actions={
          can('pricing.edit') &&
          b.status === 'active' && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New rule
            </Button>
          )
        }
      />
      <PricingTabs />
      <BookSettings book={b} />
      <Card title="Rules (highest priority first)">
        <DataTable
          caption="Rules"
          rows={rules.data?.items}
          isLoading={rules.isLoading}
          error={rules.error}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No rules yet" description="Items are priced only by published rules." />}
          columns={[
            {
              key: 'name',
              header: 'Rule',
              render: (r) => <Link href={`/t/${tenantId}/pricing/rules/${r.id}`}>{r.name}</Link>,
            },
            { key: 'priority', header: 'Priority', render: (r) => r.priority },
            {
              key: 'base',
              header: 'Base',
              render: (r) => (r.baseKind === 'metal' ? 'Metal value' : 'List price'),
            },
            {
              key: 'status',
              header: 'Status',
              render: (r) => (
                <span className="uc-row">
                  {r.status === 'published' ? (
                    <Badge tone="success">published v{r.publishedVersion}</Badge>
                  ) : r.status === 'retired' ? (
                    <Badge>retired</Badge>
                  ) : (
                    <Badge tone="warning">not published</Badge>
                  )}
                  {r.hasDraft && <Badge tone="info">draft pending</Badge>}
                </span>
              ),
            },
          ]}
        />
      </Card>
      <ListPrices book={b} />
      {creating && <NewRuleDialog book={b} onClose={() => setCreating(false)} />}
    </>
  );
}
