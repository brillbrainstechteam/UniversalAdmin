'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { currencyMinorUnits, formatMinor, type OrderSettings } from '@uc/contracts';
import {
  Alert,
  Button,
  Card,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  TextField,
  errorMessage,
  useToast,
} from '@uc/ui';
import { useEffect, useState } from 'react';
import { serverErrors } from '../../../../../lib/forms';
import { OrdersTabs } from '../../../../../lib/orders';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

/** Major-unit text ("1500.00") → minor units string for a currency with `mu` decimals, exactly (no floats). */
function toMinorText(v: string, mu: number): string | null {
  const t = v.trim();
  if (t === '') return null;
  const [whole, frac = '', extra] = t.split('.');
  if (
    extra !== undefined ||
    !/^\d{1,15}$/.test(whole ?? '') ||
    !/^\d*$/.test(frac) ||
    frac.length > mu ||
    (mu === 0 && t.includes('.'))
  )
    return 'invalid';
  return `${whole}${frac.padEnd(mu, '0')}`.replace(/^0+(?=\d)/, '');
}

export default function OrderSettingsPage() {
  const { api, can, tenantId, context } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const enabled = can('orders.read') && context.features.includes('orders');
  const mu = currencyMinorUnits(context.tenant.defaultCurrency);
  const s = useTenantQuery<OrderSettings>(
    ['orders', 'settings'],
    '/v1/admin/order-settings',
    undefined,
    enabled,
  );
  const [form, setForm] = useState({
    threshold: '',
    hold: '',
    days: '',
    orderPrefix: '',
    quotationPrefix: '',
    returnDays: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (s.data)
      setForm({
        threshold:
          s.data.approvalThresholdMinor === null ? '' : formatMinor(s.data.approvalThresholdMinor, mu),
        hold: String(s.data.checkoutHoldMinutes),
        days: String(s.data.quotationMaxDays),
        orderPrefix: s.data.orderPrefix,
        quotationPrefix: s.data.quotationPrefix,
        returnDays: String(s.data.returnWindowDays),
      });
  }, [s.data, mu]);
  const int = (v: string) => (/^\d{1,5}$/.test(v) ? Number.parseInt(v, 10) : -1);
  const save = useMutation({
    mutationFn: () => {
      const threshold = toMinorText(form.threshold, mu);
      if (threshold === 'invalid') throw new Error('Enter the threshold as an amount like 150000.00');
      return api<OrderSettings>('/v1/admin/order-settings', {
        method: 'PUT',
        body: {
          version: s.data!.version,
          approvalThresholdMinor: threshold,
          checkoutHoldMinutes: int(form.hold),
          quotationMaxDays: int(form.days),
          orderPrefix: form.orderPrefix.trim(),
          quotationPrefix: form.quotationPrefix.trim(),
          returnWindowDays: int(form.returnDays),
        },
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'orders'] });
      setErrors({});
      toast('Order settings saved');
    },
    onError: (e) => setErrors(serverErrors(e).fields),
  });
  if (!enabled) return <ForbiddenState />;
  const edit = can('settings.manage');
  return (
    <>
      <PageHeader
        title="Order settings"
        description="Approval, payment window, quotation validity, returns and numbering."
      />
      <OrdersTabs />
      <Card
        title="Rules"
        actions={
          edit &&
          s.data && (
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          )
        }
      >
        {s.error ? (
          <ErrorState error={s.error} />
        ) : !s.data ? (
          <LoadingState rows={2} />
        ) : (
          <>
            <div className="uc-form-grid">
              <TextField
                label={`Approval threshold (${context.tenant.defaultCurrency})`}
                inputMode="decimal"
                value={form.threshold}
                disabled={!edit}
                error={errors.approvalThresholdMinor}
                onChange={(e) => setForm({ ...form, threshold: e.target.value })}
                hint="Staff orders at or above this need a second person. Empty = no approval step."
              />
              <TextField
                label="Payment window (minutes)"
                inputMode="numeric"
                value={form.hold}
                disabled={!edit}
                error={errors.checkoutHoldMinutes}
                onChange={(e) => setForm({ ...form, hold: e.target.value })}
                hint="Stock is held this long for an unpaid storefront order"
              />
              <TextField
                label="Quotation maximum validity (days)"
                inputMode="numeric"
                value={form.days}
                disabled={!edit}
                error={errors.quotationMaxDays}
                onChange={(e) => setForm({ ...form, days: e.target.value })}
              />
              <TextField
                label="Order number prefix"
                value={form.orderPrefix}
                disabled={!edit}
                error={errors.orderPrefix}
                onChange={(e) => setForm({ ...form, orderPrefix: e.target.value })}
              />
              <TextField
                label="Quotation number prefix"
                value={form.quotationPrefix}
                disabled={!edit}
                error={errors.quotationPrefix}
                onChange={(e) => setForm({ ...form, quotationPrefix: e.target.value })}
              />
              <TextField
                label="Return window (days)"
                inputMode="numeric"
                value={form.returnDays}
                disabled={!edit}
                error={errors.returnWindowDays}
                onChange={(e) => setForm({ ...form, returnDays: e.target.value })}
                hint="Days after delivery (or dispatch) a customer can request a return. Your policy — not legal advice."
              />
            </div>
            {save.error && Object.keys(errors).length === 0 && (
              <Alert tone="danger">{errorMessage(save.error)}</Alert>
            )}
          </>
        )}
      </Card>
      <Alert tone="info">
        Payments run through a sandbox gateway in this build: no real money moves. A real gateway needs a
        merchant account and keys.
      </Alert>
    </>
  );
}
