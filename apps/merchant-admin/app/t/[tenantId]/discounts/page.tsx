'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { currencyMinorUnits, formatMinor, type Discount, type Page, type Segment } from '@uc/contracts';
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
  TextField,
  errorMessage,
  formatDateTime,
  useCursorPagination,
  useToast,
} from '@uc/ui';
import { useState } from 'react';
import { fromLocalInput, majorToMinor, toLocalInput, useStorefrontChannels } from '../../../../lib/growth';
import { useTenant, useTenantQuery } from '../../../../lib/tenant';

const STATE_TONE = {
  live: 'success',
  scheduled: 'info',
  expired: undefined,
  used_up: 'warning',
  disabled: undefined,
} as const;

interface Form {
  name: string;
  code: string;
  mode: 'percent' | 'fixed';
  value: string;
  minSubtotal: string;
  startsAt: string;
  endsAt: string;
  usageLimit: string;
  perCustomerLimit: string;
  segmentId: string;
  channelId: string;
  combinable: boolean;
  status: 'active' | 'disabled';
}

export default function DiscountsPage() {
  const { api, can, tenantId, context } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const tz = context.tenant.timezone;
  const currency = context.tenant.defaultCurrency;
  const mu = currencyMinorUnits(currency);
  const enabled = can('discounts.manage') && context.features.includes('discounts');
  const [q, setQ] = useState('');
  const pager = useCursorPagination(q);
  const list = useTenantQuery<Page<Discount>>(
    ['discounts', q, pager.cursor],
    '/v1/admin/discounts',
    { q: q || undefined, cursor: pager.cursor, limit: 25 },
    enabled,
  );
  const segments = useTenantQuery<{ items: Segment[] }>(
    ['segments'],
    '/v1/admin/marketing/segments',
    undefined,
    enabled && context.features.includes('marketing') && can('marketing.manage'),
  );
  const { channels } = useStorefrontChannels(enabled);
  const [editing, setEditing] = useState<Discount | 'new' | null>(null);
  const blank = (): Form => ({
    name: '',
    code: '',
    mode: 'percent',
    value: '',
    minSubtotal: '',
    startsAt: toLocalInput(new Date().toISOString()),
    endsAt: '',
    usageLimit: '',
    perCustomerLimit: '',
    segmentId: '',
    channelId: '',
    combinable: false,
    status: 'active',
  });
  const [form, setForm] = useState<Form>(blank);
  const open = (d: Discount | 'new') => {
    setEditing(d);
    setForm(
      d === 'new'
        ? blank()
        : {
            name: d.name,
            code: d.code ?? '',
            mode: d.mode,
            value: d.value.replace(/\.?0+$/, ''),
            minSubtotal: d.minSubtotalMinor ? formatMinor(d.minSubtotalMinor, mu) : '',
            startsAt: toLocalInput(d.startsAt),
            endsAt: toLocalInput(d.endsAt),
            usageLimit: d.usageLimit ? String(d.usageLimit) : '',
            perCustomerLimit: d.perCustomerLimit ? String(d.perCustomerLimit) : '',
            segmentId: d.segment?.id ?? '',
            channelId: d.channelIds[0] ?? '',
            combinable: d.combinable,
            status: d.status,
          },
    );
  };
  const int = (v: string) => (v.trim() ? Number.parseInt(v, 10) : null);
  const save = useMutation({
    mutationFn: () => {
      const min = majorToMinor(form.minSubtotal, mu);
      if (min === 'invalid') throw new Error('Enter the minimum spend as an amount like 25.00');
      const body = {
        name: form.name.trim(),
        code: form.code.trim() || null,
        mode: form.mode,
        value: form.value.trim(),
        currency: form.mode === 'fixed' ? currency : null,
        minSubtotalMinor: min,
        startsAt: fromLocalInput(form.startsAt),
        endsAt: fromLocalInput(form.endsAt),
        usageLimit: int(form.usageLimit),
        perCustomerLimit: int(form.perCustomerLimit),
        segmentId: form.segmentId || null,
        channelIds: form.channelId ? [form.channelId] : [],
        combinable: form.combinable,
        status: form.status,
        ...(editing && editing !== 'new' ? { version: editing.version } : {}),
      };
      return editing && editing !== 'new'
        ? api<Discount>(`/v1/admin/discounts/${editing.id}`, { method: 'PUT', body })
        : api<Discount>('/v1/admin/discounts', { method: 'POST', body });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'discounts'] });
      setEditing(null);
      toast('Discount saved');
    },
  });
  if (!enabled) return <ForbiddenState />;
  const amount = (d: Discount) =>
    d.mode === 'percent'
      ? `${d.value.replace(/\.?0+$/, '')}%`
      : `${d.currency} ${d.value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}`;
  return (
    <>
      <PageHeader
        title="Discounts"
        description="Order discounts, automatic or with a code. They are checked by the server on every price and taken off before tax."
        actions={
          <Button variant="primary" onClick={() => open('new')}>
            New discount
          </Button>
        }
      />
      <Card>
        <div className="uc-filters" role="search">
          <TextField
            label="Search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name or code"
          />
        </div>
        <DataTable
          caption="Discounts"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          rowKey={(d) => d.id}
          pagination={pager.controls(list.data?.nextCursor)}
          empty={<EmptyState title="No discounts yet" />}
          columns={[
            {
              key: 'n',
              header: 'Discount',
              render: (d) => (
                <Button size="sm" variant="ghost" onClick={() => open(d)}>
                  {d.name}
                </Button>
              ),
            },
            {
              key: 'c',
              header: 'Code',
              render: (d) => (d.code ? <span className="uc-mono">{d.code}</span> : <Badge>automatic</Badge>),
            },
            { key: 'a', header: 'Amount', render: (d) => amount(d) },
            {
              key: 's',
              header: 'State',
              render: (d) => <Badge tone={STATE_TONE[d.state]}>{d.state.replace('_', ' ')}</Badge>,
            },
            {
              key: 'u',
              header: 'Used',
              render: (d) => `${d.usedCount}${d.usageLimit ? ` / ${d.usageLimit}` : ''}`,
            },
            {
              key: 'w',
              header: 'Window',
              render: (d) =>
                `${formatDateTime(d.startsAt, tz)}${d.endsAt ? ` → ${formatDateTime(d.endsAt, tz)}` : ''}`,
            },
            {
              key: 'x',
              header: 'Rules',
              render: (d) =>
                [
                  d.segment ? `segment: ${d.segment.name}` : null,
                  d.perCustomerLimit ? `${d.perCustomerLimit} per customer` : null,
                  d.combinable ? 'combinable' : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || '—',
            },
          ]}
        />
      </Card>
      <Dialog
        open={editing !== null}
        title={editing === 'new' ? 'New discount' : `Edit ${editing?.name ?? ''}`}
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!form.name.trim() || !form.value.trim()}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              Save
            </Button>
          </>
        }
      >
        {editing && editing !== 'new' && editing.usedCount > 0 && (
          <Alert tone="info">
            Used {editing.usedCount} time(s): the code and amount are fixed; you can change dates, limits and
            status.
          </Alert>
        )}
        <div className="uc-form-grid">
          <TextField
            label="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <TextField
            label="Code (empty = automatic)"
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
          />
          <SelectField
            label="Type"
            value={form.mode}
            onChange={(e) => setForm({ ...form, mode: e.target.value as Form['mode'] })}
            options={[
              { value: 'percent', label: 'Percentage of the order' },
              { value: 'fixed', label: `Fixed amount (${currency})` },
            ]}
          />
          <TextField
            label={form.mode === 'percent' ? 'Percent' : `Amount (${currency})`}
            inputMode="decimal"
            value={form.value}
            onChange={(e) => setForm({ ...form, value: e.target.value })}
          />
          <TextField
            label={`Minimum spend (${currency}, optional)`}
            inputMode="decimal"
            value={form.minSubtotal}
            onChange={(e) => setForm({ ...form, minSubtotal: e.target.value })}
          />
          <TextField
            label="Starts"
            type="datetime-local"
            value={form.startsAt}
            onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
          />
          <TextField
            label="Ends (optional)"
            type="datetime-local"
            value={form.endsAt}
            onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
          />
          <TextField
            label="Total uses (optional)"
            inputMode="numeric"
            value={form.usageLimit}
            onChange={(e) => setForm({ ...form, usageLimit: e.target.value.replace(/\D/g, '') })}
          />
          <TextField
            label="Uses per customer (optional)"
            inputMode="numeric"
            value={form.perCustomerLimit}
            onChange={(e) => setForm({ ...form, perCustomerLimit: e.target.value.replace(/\D/g, '') })}
            hint="Customers must sign in"
          />
          <SelectField
            label="Customer segment (optional)"
            value={form.segmentId}
            onChange={(e) => setForm({ ...form, segmentId: e.target.value })}
            options={[
              { value: '', label: 'Everyone' },
              ...(segments.data?.items ?? []).map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
          <SelectField
            label="Storefront"
            value={form.channelId}
            onChange={(e) => setForm({ ...form, channelId: e.target.value })}
            options={[
              { value: '', label: 'All storefronts' },
              ...channels.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          <SelectField
            label="Status"
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value as Form['status'] })}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'disabled', label: 'Disabled' },
            ]}
          />
        </div>
        <Checkbox
          label="Can be combined with other discounts"
          description="If any applicable discount is not combinable, only the largest one applies"
          checked={form.combinable}
          onChange={(e) => setForm({ ...form, combinable: e.target.checked })}
        />
        {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
      </Dialog>
    </>
  );
}
