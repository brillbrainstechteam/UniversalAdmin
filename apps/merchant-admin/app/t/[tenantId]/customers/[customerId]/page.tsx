'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CustomerDetail, OrderSummary, Page } from '@uc/contracts';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  errorMessage,
  formatDateTime,
  useToast,
} from '@uc/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Status } from '../../../../../lib/orders';
import { money } from '../../../../../lib/pricing';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

export default function CustomerPage() {
  const { customerId } = useParams<{ customerId: string }>();
  const { api, can, tenantId, context } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const tz = context.tenant.timezone;
  const enabled = can('customers.read') && context.features.includes('customers');
  const c = useTenantQuery<CustomerDetail>(
    ['customers', customerId],
    `/v1/admin/customers/${customerId}`,
    undefined,
    enabled,
  );
  const orders = useTenantQuery<Page<OrderSummary>>(
    ['orders', 'by-customer', customerId],
    '/v1/admin/orders',
    { customerId, limit: 25 },
    enabled && can('orders.read'),
  );
  const [confirm, setConfirm] = useState(false);
  const toggle = useMutation({
    mutationFn: (reason: string) =>
      api(`/v1/admin/customers/${customerId}/status`, {
        method: 'PUT',
        body: {
          version: c.data!.version,
          status: c.data!.status === 'active' ? 'disabled' : 'active',
          reason,
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'customers'] });
      setConfirm(false);
      toast('Customer updated');
    },
  });
  if (!enabled) return <ForbiddenState />;
  if (c.error) return <ErrorState error={c.error} onRetry={() => void c.refetch()} />;
  if (!c.data) return <LoadingState />;
  const d = c.data;
  const active = d.status === 'active';
  return (
    <>
      <PageHeader
        title={d.displayName}
        description={`${d.email}${d.phone ? ` · ${d.phone}` : ''} · joined ${formatDateTime(d.createdAt, tz)}`}
        actions={
          can('customers.manage') && (
            <Button variant={active ? 'danger' : 'primary'} onClick={() => setConfirm(true)}>
              {active ? 'Disable account' : 'Re-enable account'}
            </Button>
          )
        }
      />
      <div className="uc-row">
        <Badge tone={active ? 'success' : undefined}>{d.status}</Badge>
        <Badge tone={d.emailVerified ? 'success' : 'warning'}>
          {d.emailVerified ? 'e-mail verified' : 'e-mail not verified'}
        </Badge>
        {d.isDemo && <Badge>demo</Badge>}
      </div>
      <Card title="Marketing preferences">
        <p>
          E-mail: <strong>{d.preferences.email ? 'yes' : 'no'}</strong> · SMS:{' '}
          <strong>{d.preferences.sms ? 'yes' : 'no'}</strong> · WhatsApp:{' '}
          <strong>{d.preferences.whatsapp ? 'yes' : 'no'}</strong>
        </p>
        <DataTable
          caption="Consent history"
          rows={d.consentHistory}
          rowKey={(h) => `${h.createdAt}-${h.channel}-${String(h.granted)}`}
          empty={<EmptyState title="No consent recorded" />}
          columns={[
            { key: 'when', header: 'When', render: (h) => formatDateTime(h.createdAt, tz) },
            { key: 'ch', header: 'Channel', render: (h) => h.channel },
            { key: 'g', header: 'Choice', render: (h) => (h.granted ? 'Opted in' : 'Opted out') },
            { key: 'src', header: 'Source', render: (h) => h.source },
          ]}
        />
      </Card>
      <Card title="Addresses">
        {d.addresses.length === 0 ? (
          <EmptyState title="No saved addresses" />
        ) : (
          <ul className="uc-stack">
            {d.addresses.map((a) => (
              <li key={a.id}>
                {a.label && <strong>{a.label}: </strong>}
                {a.address.line1}, {a.address.city} {a.address.countryCode}{' '}
                {a.isDefault && <Badge>default</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={`Orders (${d.orderCount})`}>
        <DataTable
          caption="Orders"
          rows={orders.data?.items}
          isLoading={orders.isLoading}
          error={orders.error}
          rowKey={(o) => o.id}
          empty={<EmptyState title="No orders" />}
          columns={[
            {
              key: 'n',
              header: 'Order',
              render: (o) => <Link href={`/t/${tenantId}/orders/${o.id}`}>{o.number}</Link>,
            },
            { key: 'when', header: 'Placed', render: (o) => formatDateTime(o.createdAt, tz) },
            { key: 'st', header: 'Status', render: (o) => <Status value={o.status} /> },
            { key: 'ful', header: 'Fulfillment', render: (o) => <Status value={o.fulfillmentStatus} /> },
            {
              key: 't',
              header: 'Total',
              render: (o) => <span className="uc-mono">{money(o.totalMinor, o.currency)}</span>,
            },
          ]}
        />
      </Card>
      <ConfirmDialog
        open={confirm}
        title={active ? `Disable ${d.displayName}` : `Re-enable ${d.displayName}`}
        description={
          active
            ? 'The customer is signed out everywhere and cannot sign in.'
            : 'The customer can sign in again.'
        }
        confirmLabel={active ? 'Disable' : 'Re-enable'}
        tone={active ? 'danger' : 'primary'}
        requireReason
        loading={toggle.isPending}
        error={toggle.error ? errorMessage(toggle.error) : null}
        onConfirm={(reason) => toggle.mutate(reason)}
        onClose={() => setConfirm(false)}
      />
    </>
  );
}
