'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CreatePriceBookRequest, type PriceBook, type PricingCatalogOptions } from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  ForbiddenState,
  PageHeader,
  SelectField,
  TextField,
  useToast,
} from '@uc/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { serverErrors, validate } from '../../../../../lib/forms';
import { PricingTabs } from '../../../../../lib/pricing';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

function NewBookDialog({ onClose }: { onClose: () => void }) {
  const { api, tenantId } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const options = useTenantQuery<PricingCatalogOptions>(['pricing', 'options'], '/v1/admin/pricing/options');
  const [form, setForm] = useState({ name: '', channelId: '', priority: '0' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) => api<PriceBook>('/v1/admin/pricing/books', { method: 'POST', body }),
    onSuccess: (b) => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'pricing'] });
      toast('Price book created');
      router.push(`/t/${tenantId}/pricing/books/${b.id}`);
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
      channelId: form.channelId || null,
      priority: /^\d{1,4}$/.test(form.priority) ? Number.parseInt(form.priority, 10) : -1,
    };
    const check = validate(CreatePriceBookRequest, body);
    if (!check.ok) return setErrors(check.errors);
    save.mutate(body);
  }
  return (
    <Dialog
      open
      title="New price book"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            Create
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
        <SelectField
          label="Channel"
          value={form.channelId}
          onChange={(e) => setForm({ ...form, channelId: e.target.value })}
          options={[
            { value: '', label: 'All channels' },
            ...(options.data?.channels ?? []).map((c) => ({ value: c.id, label: c.name })),
          ]}
          hint="A channel-specific book is used before all-channel books for that channel"
        />
        <TextField
          label="Priority"
          inputMode="numeric"
          value={form.priority}
          error={errors.priority}
          onChange={(e) => setForm({ ...form, priority: e.target.value })}
          hint="Higher priority books are tried first (0–1000)"
        />
      </div>
      <span className="uc-muted">Currency: {options.data?.currency ?? '…'} (the merchant currency)</span>
      {message && <Alert tone="danger">{message}</Alert>}
    </Dialog>
  );
}

export default function PriceBooksPage() {
  const { can, tenantId, context } = useTenant();
  const enabled = can('pricing.read') && context.features.includes('pricing');
  const books = useTenantQuery<{ items: PriceBook[] }>(
    ['pricing', 'books'],
    '/v1/admin/pricing/books',
    undefined,
    enabled,
  );
  const [creating, setCreating] = useState(false);
  if (!enabled) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="Price books & rules"
        description="For a channel, channel-specific books are tried first, then all-channel books, each by priority. Inside a book the highest-priority matching rule wins."
        actions={
          can('pricing.edit') && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New price book
            </Button>
          )
        }
      />
      <PricingTabs />
      <Card>
        <DataTable
          caption="Price books"
          rows={books.data?.items}
          isLoading={books.isLoading}
          error={books.error}
          onRetry={() => void books.refetch()}
          rowKey={(b) => b.id}
          empty={<EmptyState title="No price books" description="Create one, then add rules to it." />}
          columns={[
            {
              key: 'name',
              header: 'Name',
              render: (b) => <Link href={`/t/${tenantId}/pricing/books/${b.id}`}>{b.name}</Link>,
            },
            { key: 'channel', header: 'Channel', render: (b) => b.channel?.name ?? 'All channels' },
            { key: 'priority', header: 'Priority', render: (b) => b.priority },
            { key: 'currency', header: 'Currency', render: (b) => b.currency },
            { key: 'rules', header: 'Active rules', render: (b) => b.ruleCount },
            { key: 'prices', header: 'List prices', render: (b) => b.listPriceCount },
            {
              key: 'status',
              header: 'Status',
              render: (b) => <Badge tone={b.status === 'active' ? 'success' : undefined}>{b.status}</Badge>,
            },
          ]}
        />
      </Card>
      {creating && <NewBookDialog onClose={() => setCreating(false)} />}
    </>
  );
}
