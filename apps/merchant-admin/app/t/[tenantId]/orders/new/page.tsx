'use client';

import { useMutation } from '@tanstack/react-query';
import {
  CreateOrderRequest,
  type Contact,
  type Order,
  type OrderSettings,
  type PricingCatalogOptions,
} from '@uc/contracts';
import {
  Alert,
  Button,
  Card,
  ForbiddenState,
  PageHeader,
  SelectField,
  TextField,
  newIdempotencyKey,
} from '@uc/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { serverErrors, validate } from '../../../../../lib/forms';
import {
  ContactFields,
  LineBuilder,
  OrdersTabs,
  toLineInputs,
  type DraftLine,
} from '../../../../../lib/orders';
import { money } from '../../../../../lib/pricing';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

export default function NewOrderPage() {
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
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  // One key per form: a double click or a retry after a network error never creates two orders.
  const [idemKey] = useState(() => newIdempotencyKey());
  const save = useMutation({
    mutationFn: (body: unknown) =>
      api<Order>('/v1/admin/orders', { method: 'POST', body, idempotencyKey: idemKey }),
    onSuccess: (o) => router.push(`/t/${tenantId}/orders/${o.id}`),
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
      note: note.trim() || null,
      lines: toLineInputs(lines),
    };
    const check = validate(CreateOrderRequest, body);
    if (!check.ok) {
      setErrors(check.errors);
      setMessage(lines.length ? 'Fix the highlighted fields' : 'Add at least one line');
      return;
    }
    setMessage(null);
    save.mutate(body);
  }
  const threshold = settings.data?.approvalThresholdMinor;
  return (
    <>
      <PageHeader
        title="New order"
        description="A staff order on account. The server prices every line, holds the stock, then confirms it (or sends it for approval)."
      />
      <OrdersTabs />
      <Card title="Customer">
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
            hint="Decides which price book applies"
          />
          <TextField
            label="Internal note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </Card>
      <Card title="Lines">
        <LineBuilder lines={lines} onChange={setLines} channelId={channelId || null} />
      </Card>
      {threshold && options.data && (
        <Alert tone="info">
          Orders of {money(threshold, options.data.currency)} or more wait for a second person to approve
          them.
        </Alert>
      )}
      {message && <Alert tone="danger">{message}</Alert>}
      <div className="uc-row">
        <Button variant="primary" loading={save.isPending} onClick={submit}>
          Create order
        </Button>
      </div>
    </>
  );
}
