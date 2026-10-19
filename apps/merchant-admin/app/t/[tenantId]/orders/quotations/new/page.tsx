'use client';

import { useMutation } from '@tanstack/react-query';
import {
  CreateQuotationRequest,
  type Contact,
  type OrderSettings,
  type PricingCatalogOptions,
  type Quotation,
} from '@uc/contracts';
import { Alert, Button, Card, ForbiddenState, PageHeader, SelectField, TextField } from '@uc/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { serverErrors, validate } from '../../../../../../lib/forms';
import {
  ContactFields,
  LineBuilder,
  OrdersTabs,
  toLineInputs,
  type DraftLine,
} from '../../../../../../lib/orders';
import { useTenant, useTenantQuery } from '../../../../../../lib/tenant';

/** Local date-time input value for N days from now. */
function inDays(days: number): string {
  const d = new Date(Date.now() + days * 24 * 3600_000);
  d.setSeconds(0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function NewQuotationPage() {
  const { api, can, tenantId, context } = useTenant();
  const router = useRouter();
  const enabled = can('orders.manage') && context.features.includes('orders');
  const options = useTenantQuery<PricingCatalogOptions>(
    ['pricing', 'options'],
    '/v1/admin/pricing/options',
    undefined,
    enabled && can('pricing.read'),
  );
  const settings = useTenantQuery<OrderSettings>(
    ['orders', 'settings'],
    '/v1/admin/order-settings',
    undefined,
    enabled,
  );
  const [channelId, setChannelId] = useState('');
  const [contact, setContact] = useState<Contact>({ name: '', email: '', phone: null });
  const [validUntil, setValidUntil] = useState(() => inDays(3));
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) => api<Quotation>('/v1/admin/quotations', { method: 'POST', body }),
    onSuccess: (q) => router.push(`/t/${tenantId}/orders/quotations/${q.id}`),
    onError: (e) => {
      const r = serverErrors(e);
      setErrors(r.fields);
      setMessage(r.message);
    },
  });
  if (!enabled) return <ForbiddenState />;
  function submit() {
    const body = {
      channelId: channelId || null,
      contact: { ...contact, phone: contact.phone || null },
      lines: toLineInputs(lines),
      validUntil: validUntil ? new Date(validUntil).toISOString() : '',
      notes: notes.trim() || null,
    };
    const check = validate(CreateQuotationRequest, body);
    if (!check.ok) {
      setErrors(check.errors);
      setMessage(lines.length ? 'Fix the highlighted fields' : 'Add at least one line');
      return;
    }
    save.mutate(body);
  }
  return (
    <>
      <PageHeader
        title="New quotation"
        description="Saved as a draft. The price is frozen only when you send it."
      />
      <OrdersTabs />
      <Card title="Customer and validity">
        <ContactFields value={contact} onChange={setContact} errors={errors} />
        <div className="uc-form-grid">
          <SelectField
            label="Channel"
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            options={[
              { value: '', label: 'No specific channel' },
              ...(options.data?.channels ?? []).map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          <TextField
            label="Valid until"
            type="datetime-local"
            value={validUntil}
            error={errors.validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
            hint={settings.data ? `At most ${settings.data.quotationMaxDays} days ahead` : undefined}
          />
          <TextField
            label="Notes for the customer (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </Card>
      <Card title="Lines">
        <LineBuilder lines={lines} onChange={setLines} channelId={channelId || null} />
      </Card>
      {message && <Alert tone="danger">{message}</Alert>}
      <div className="uc-row">
        <Button variant="primary" loading={save.isPending} onClick={submit}>
          Save draft
        </Button>
      </div>
    </>
  );
}
