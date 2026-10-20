'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { currencyMinorUnits, type Order, type OrderReturn } from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  SelectField,
  TextField,
  errorMessage,
  formatDateTime,
  newIdempotencyKey,
  useToast,
} from '@uc/ui';
import { useState } from 'react';
import { toMinorText } from './companies';
import { useLocations } from './inventory';
import { Status } from './orders';
import { money } from './pricing';
import { useTenant } from './tenant';

/** Shared refresh after any fulfilment action. */
function useDone() {
  const qc = useQueryClient();
  const toast = useToast();
  const { tenantId } = useTenant();
  return (message: string) => {
    void qc.invalidateQueries({ queryKey: ['t', tenantId, 'orders'] });
    void qc.invalidateQueries({ queryKey: ['t', tenantId, 'returns'] });
    toast(message);
  };
}

/** Pick-pack-ship: pack from what is left, dispatch (carrier typed manually), deliver; cancel unshipped items. */
export function FulfillmentPanel({ order: o }: { order: Order }) {
  const { api, can, context } = useTenant();
  const done = useDone();
  const tz = context.tenant.timezone;
  const [qty, setQty] = useState<Record<number, string>>({});
  const [shipping, setShipping] = useState<Order['shipments'][number] | null>(null);
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [cancelRest, setCancelRest] = useState(false);
  const canShip = can('fulfillment.manage') && context.features.includes('fulfillment');
  const shippable = o.lines.filter((l) => l.shippableQuantity > 0);
  const pack = useMutation({
    mutationFn: () =>
      api(`/v1/admin/orders/${o.id}/shipments`, {
        method: 'POST',
        body: {
          lines: shippable
            .map((l) => ({
              lineNo: l.lineNo,
              quantity: Number.parseInt(qty[l.lineNo] ?? String(l.shippableQuantity), 10),
            }))
            .filter((l) => l.quantity > 0),
        },
      }),
    onSuccess: () => {
      setQty({});
      done('Shipment packed');
    },
  });
  const act = useMutation({
    mutationFn: (v: { id: string; action: 'ship' | 'deliver' | 'cancel'; version: number }) =>
      api(`/v1/admin/orders/${o.id}/shipments/${v.id}/${v.action}`, {
        method: 'POST',
        body:
          v.action === 'ship'
            ? { version: v.version, carrier: carrier.trim(), trackingNumber: tracking.trim() || null }
            : { version: v.version },
      }),
    onSuccess: (_d, v) => {
      setShipping(null);
      setCarrier('');
      setTracking('');
      done(
        v.action === 'ship'
          ? 'Shipment dispatched; stock left the building'
          : v.action === 'deliver'
            ? 'Marked delivered'
            : 'Shipment unpacked',
      );
    },
  });
  const rest = useMutation({
    mutationFn: (reason: string) =>
      api(`/v1/admin/orders/${o.id}/cancel-remaining`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      setCancelRest(false);
      done('Unshipped items cancelled; stock released');
    },
  });
  if (!context.features.includes('fulfillment')) return null;
  return (
    <Card
      title="Fulfillment"
      actions={
        o.fulfillmentStatus === 'partial' &&
        o.status === 'confirmed' &&
        can('orders.manage') && (
          <Button variant="danger" size="sm" onClick={() => setCancelRest(true)}>
            Cancel unshipped items
          </Button>
        )
      }
    >
      <div className="uc-row">
        <Status value={o.fulfillmentStatus} />
        <span className="uc-muted">
          Carriers and tracking numbers are entered by hand; no courier is connected, so nothing is tracked
          automatically.
        </span>
      </div>
      {o.status === 'confirmed' && canShip && shippable.length > 0 && (
        <div className="uc-stack">
          <strong>Pack a shipment</strong>
          <div className="uc-form-grid">
            {shippable.map((l) => (
              <TextField
                key={l.lineNo}
                label={`Line ${l.lineNo} · ${l.sku}${l.serialTag ? ` · ${l.serialTag}` : ''} (left: ${l.shippableQuantity})`}
                inputMode="numeric"
                value={qty[l.lineNo] ?? String(l.shippableQuantity)}
                onChange={(e) => setQty({ ...qty, [l.lineNo]: e.target.value.replace(/\D/g, '') })}
              />
            ))}
          </div>
          {pack.error && <Alert tone="danger">{errorMessage(pack.error)}</Alert>}
          <div className="uc-row">
            <Button variant="primary" loading={pack.isPending} onClick={() => pack.mutate()}>
              Pack shipment
            </Button>
          </div>
        </div>
      )}
      <DataTable
        caption="Shipments"
        rows={o.shipments}
        rowKey={(s) => s.id}
        empty={<EmptyState title="No shipments yet" />}
        columns={[
          { key: 'n', header: 'Shipment', render: (s) => <span className="uc-mono">{s.number}</span> },
          { key: 'st', header: 'Status', render: (s) => <Status value={s.status} /> },
          {
            key: 'lines',
            header: 'Items',
            render: (s) =>
              s.lines
                .map((l) => `${l.sku}${l.serialTag ? ` (${l.serialTag})` : ''} × ${l.quantity}`)
                .join(', '),
          },
          {
            key: 'carrier',
            header: 'Carrier (manual)',
            render: (s) =>
              s.carrier ? `${s.carrier}${s.trackingNumber ? ` · ${s.trackingNumber}` : ''}` : '—',
          },
          {
            key: 'when',
            header: 'Shipped',
            render: (s) => (s.shippedAt ? formatDateTime(s.shippedAt, tz) : '—'),
          },
          {
            key: 'act',
            header: 'Actions',
            render: (s) =>
              canShip && (
                <div className="uc-row">
                  {s.status === 'packed' && (
                    <>
                      <Button size="sm" variant="primary" onClick={() => setShipping(s)}>
                        Ship
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => act.mutate({ id: s.id, action: 'cancel', version: s.version })}
                      >
                        Unpack
                      </Button>
                    </>
                  )}
                  {s.status === 'shipped' && (
                    <Button
                      size="sm"
                      onClick={() => act.mutate({ id: s.id, action: 'deliver', version: s.version })}
                    >
                      Mark delivered
                    </Button>
                  )}
                </div>
              ),
          },
        ]}
      />
      {act.error && !shipping && <Alert tone="danger">{errorMessage(act.error)}</Alert>}
      <Dialog
        open={shipping !== null}
        title={`Ship ${shipping?.number ?? ''}`}
        onClose={() => setShipping(null)}
        footer={
          <>
            <Button onClick={() => setShipping(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!carrier.trim()}
              loading={act.isPending}
              onClick={() =>
                shipping && act.mutate({ id: shipping.id, action: 'ship', version: shipping.version })
              }
            >
              Dispatch
            </Button>
          </>
        }
      >
        <p>
          The items leave stock now (on-hand and committed both fall). This cannot be undone; use a return if
          goods come back.
        </p>
        <TextField label="Carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)} required />
        <TextField
          label="Tracking number (optional)"
          value={tracking}
          onChange={(e) => setTracking(e.target.value)}
          hint="Typed by you; not checked with the carrier"
        />
        {act.error && <Alert tone="danger">{errorMessage(act.error)}</Alert>}
      </Dialog>
      <ConfirmDialog
        open={cancelRest}
        title={`Cancel unshipped items on ${o.number}`}
        description="Everything not yet shipped is released back to stock. For a paid order, the value of those items becomes a refund due."
        confirmLabel="Cancel unshipped items"
        requireReason
        loading={rest.isPending}
        error={rest.error ? errorMessage(rest.error) : null}
        onConfirm={(reason) => rest.mutate(reason)}
        onClose={() => setCancelRest(false)}
      />
    </Card>
  );
}

/** Returns on this order: record one (staff), approve/reject, receive with or without restocking. */
export function ReturnsPanel({ order: o }: { order: Order }) {
  const { api, can, context } = useTenant();
  const done = useDone();
  const canAct = can('fulfillment.manage') && context.features.includes('fulfillment');
  const returnable = o.lines.filter((l) => l.shippedQuantity > 0);
  const [creating, setCreating] = useState(false);
  const [lines, setLines] = useState<Record<number, string>>({});
  const [reason, setReason] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api(`/v1/admin/orders/${o.id}/returns`, {
        method: 'POST',
        body: {
          reason: reason.trim(),
          lines: Object.entries(lines)
            .map(([lineNo, q]) => ({
              lineNo: Number.parseInt(lineNo, 10),
              quantity: Number.parseInt(q || '0', 10),
            }))
            .filter((l) => l.quantity > 0),
        },
      }),
    onSuccess: () => {
      setCreating(false);
      setLines({});
      setReason('');
      done('Return recorded');
    },
  });
  if (!context.features.includes('fulfillment') || (o.returns.length === 0 && returnable.length === 0))
    return null;
  return (
    <Card
      title="Returns"
      actions={
        canAct &&
        returnable.length > 0 && (
          <Button size="sm" onClick={() => setCreating(true)}>
            Record a return
          </Button>
        )
      }
    >
      <ReturnTable rows={o.returns} />
      <Dialog
        open={creating}
        title={`Return items from ${o.number}`}
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={reason.trim().length < 3}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              Record return
            </Button>
          </>
        }
      >
        {returnable.map((l) => (
          <TextField
            key={l.lineNo}
            label={`Line ${l.lineNo} · ${l.sku}${l.serialTag ? ` · ${l.serialTag}` : ''} (shipped ${l.shippedQuantity})`}
            inputMode="numeric"
            value={lines[l.lineNo] ?? ''}
            onChange={(e) => setLines({ ...lines, [l.lineNo]: e.target.value.replace(/\D/g, '') })}
          />
        ))}
        <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
        {create.error && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
      </Dialog>
    </Card>
  );
}

/** Return rows with decide/receive actions (used on the order page and the Returns list). */
export function ReturnTable({
  rows,
  showOrder = false,
  pagination,
}: {
  rows: OrderReturn[];
  showOrder?: boolean;
  pagination?: Parameters<typeof DataTable<OrderReturn>>[0]['pagination'];
}) {
  const { api, can, context, tenantId } = useTenant();
  const done = useDone();
  const locations = useLocations(can('fulfillment.manage'));
  const canAct = can('fulfillment.manage') && context.features.includes('fulfillment');
  const [rejecting, setRejecting] = useState<OrderReturn | null>(null);
  const [receiving, setReceiving] = useState<OrderReturn | null>(null);
  const [restock, setRestock] = useState(true);
  const [loc, setLoc] = useState('');
  const decide = useMutation({
    mutationFn: (v: { r: OrderReturn; approve: boolean; note: string | null }) =>
      api(`/v1/admin/returns/${v.r.id}/decide`, {
        method: 'POST',
        body: { version: v.r.version, approve: v.approve, note: v.note },
      }),
    onSuccess: (_d, v) => {
      setRejecting(null);
      done(v.approve ? 'Return approved' : 'Return rejected');
    },
  });
  const receive = useMutation({
    mutationFn: (r: OrderReturn) =>
      api(`/v1/admin/returns/${r.id}/receive`, {
        method: 'POST',
        body: { version: r.version, restock, locationId: loc || locations.options[0]?.value },
      }),
    onSuccess: () => {
      setReceiving(null);
      done(restock ? 'Return received and restocked' : 'Return received (not restocked)');
    },
  });
  return (
    <>
      <DataTable
        caption="Returns"
        rows={rows}
        rowKey={(r) => r.id}
        pagination={pagination}
        empty={<EmptyState title="No returns" />}
        columns={[
          { key: 'n', header: 'Return', render: (r) => <span className="uc-mono">{r.number}</span> },
          ...(showOrder
            ? [
                {
                  key: 'o',
                  header: 'Order',
                  render: (r: OrderReturn) => (
                    <a href={`/t/${tenantId}/orders/${r.orderId}`}>{r.orderNumber}</a>
                  ),
                },
              ]
            : []),
          { key: 'st', header: 'Status', render: (r) => <Status value={r.status} /> },
          { key: 'by', header: 'Requested by', render: (r) => <Badge>{r.requestedBy}</Badge> },
          {
            key: 'items',
            header: 'Items',
            render: (r) =>
              r.lines
                .map((l) => `${l.sku}${l.serialTag ? ` (${l.serialTag})` : ''} × ${l.quantity}`)
                .join(', '),
          },
          {
            key: 'v',
            header: 'Value',
            render: (r) => (
              <span className="uc-mono">
                {money(r.valueMinor, r.currency, currencyMinorUnits(r.currency))}
              </span>
            ),
          },
          { key: 'why', header: 'Reason', render: (r) => r.reason },
          {
            key: 'act',
            header: 'Actions',
            render: (r) =>
              canAct && (
                <div className="uc-row">
                  {r.status === 'requested' && (
                    <>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => decide.mutate({ r, approve: true, note: null })}
                      >
                        Approve
                      </Button>
                      <Button size="sm" onClick={() => setRejecting(r)}>
                        Reject
                      </Button>
                    </>
                  )}
                  {r.status === 'approved' && (
                    <Button size="sm" variant="primary" onClick={() => setReceiving(r)}>
                      Receive
                    </Button>
                  )}
                  {r.status === 'received' && (
                    <span className="uc-muted">{r.restocked ? 'Restocked' : 'Not restocked'}</span>
                  )}
                </div>
              ),
          },
        ]}
      />
      {decide.error && !rejecting && <Alert tone="danger">{errorMessage(decide.error)}</Alert>}
      <ConfirmDialog
        open={rejecting !== null}
        title={`Reject return ${rejecting?.number ?? ''}`}
        description="The customer sees the reason."
        confirmLabel="Reject return"
        requireReason
        loading={decide.isPending}
        error={decide.error ? errorMessage(decide.error) : null}
        onConfirm={(note) => rejecting && decide.mutate({ r: rejecting, approve: false, note })}
        onClose={() => setRejecting(null)}
      />
      <Dialog
        open={receiving !== null}
        title={`Receive return ${receiving?.number ?? ''}`}
        onClose={() => setReceiving(null)}
        footer={
          <>
            <Button onClick={() => setReceiving(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={receive.isPending}
              onClick={() => receiving && receive.mutate(receiving)}
            >
              Receive
            </Button>
          </>
        }
      >
        <Checkbox
          label="Put the items back into sellable stock"
          description="Untick for damaged goods: nothing is added to stock and returned pieces are written off"
          checked={restock}
          onChange={(e) => setRestock(e.target.checked)}
        />
        <SelectField
          label="Receive at"
          value={loc || locations.options[0]?.value || ''}
          onChange={(e) => setLoc(e.target.value)}
          options={locations.options}
        />
        {receive.error && <Alert tone="danger">{errorMessage(receive.error)}</Alert>}
      </Dialog>
    </>
  );
}

/** Refunds (sandbox gateway): never more than captured minus already refunded. */
export function RefundsPanel({ order: o }: { order: Order }) {
  const { api, can, context } = useTenant();
  const done = useDone();
  const mu = currencyMinorUnits(o.currency);
  const tz = context.tenant.timezone;
  const captured = o.payments.filter((p) => p.status === 'captured');
  const refundable = captured.reduce((a, p) => a + BigInt(p.amountMinor) - BigInt(p.refundedMinor), 0n);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [returnId, setReturnId] = useState('');
  const [key, setKey] = useState(() => newIdempotencyKey());
  const minor = toMinorText(amount, mu);
  const tooMuch = minor && minor !== 'invalid' && BigInt(minor) > refundable;
  const create = useMutation({
    mutationFn: () =>
      api(`/v1/admin/orders/${o.id}/refunds`, {
        method: 'POST',
        body: { amountMinor: minor, reason: reason.trim(), returnId: returnId || null },
        idempotencyKey: key,
      }),
    onSuccess: () => {
      setOpen(false);
      setAmount('');
      setReason('');
      setKey(newIdempotencyKey());
      done('Refund sent to the sandbox gateway');
    },
  });
  if (captured.length === 0 && o.refunds.length === 0) return null;
  return (
    <Card
      title="Refunds"
      actions={
        can('payments.refund') &&
        refundable > 0n && (
          <Button size="sm" onClick={() => setOpen(true)}>
            Issue refund
          </Button>
        )
      }
    >
      <span className="uc-muted">
        Refundable: <span className="uc-mono">{money(refundable.toString(), o.currency, mu)}</span>. Refunds
        go through the SANDBOX gateway (no real money) and are only marked successful when its signed callback
        arrives.
      </span>
      <DataTable
        caption="Refunds"
        rows={o.refunds}
        rowKey={(r) => r.id}
        empty={<EmptyState title="No refunds" />}
        columns={[
          { key: 'when', header: 'When', render: (r) => formatDateTime(r.createdAt, tz) },
          {
            key: 'amt',
            header: 'Amount',
            render: (r) => <span className="uc-mono">{money(r.amountMinor, r.currency, mu)}</span>,
          },
          { key: 'st', header: 'Status', render: (r) => <Status value={r.status} /> },
          { key: 'gw', header: 'Gateway', render: () => <Badge tone="warning">SANDBOX</Badge> },
          { key: 'why', header: 'Reason', render: (r) => r.failureReason ?? r.reason },
          { key: 'by', header: 'By', render: (r) => r.createdBy?.name ?? '—' },
        ]}
      />
      <Dialog
        open={open}
        title={`Refund on ${o.number}`}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={
                !minor || minor === 'invalid' || minor === '0' || !!tooMuch || reason.trim().length < 3
              }
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              Refund
            </Button>
          </>
        }
      >
        <TextField
          label={`Amount (${o.currency})`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          error={
            minor === 'invalid'
              ? 'Enter an amount like 12.50'
              : tooMuch
                ? 'More than can be refunded'
                : undefined
          }
          hint={`Up to ${money(refundable.toString(), o.currency, mu)}${o.refundDueMinor !== '0' ? ` · refund due ${money(o.refundDueMinor, o.currency, mu)}` : ''}`}
          inputMode="decimal"
        />
        {o.returns.some((r) => r.status === 'approved' || r.status === 'received') && (
          <SelectField
            label="For return (optional)"
            value={returnId}
            onChange={(e) => setReturnId(e.target.value)}
            options={[
              { value: '', label: '—' },
              ...o.returns
                .filter((r) => r.status === 'approved' || r.status === 'received')
                .map((r) => ({ value: r.id, label: `${r.number} · ${money(r.valueMinor, r.currency, mu)}` })),
            ]}
          />
        )}
        <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
        {create.error && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
      </Dialog>
    </Card>
  );
}

/** Customer messages: recorded only — no e-mail connector exists yet. */
export function MessagesPanel({ order: o }: { order: Order }) {
  const { context } = useTenant();
  if (o.messages.length === 0) return null;
  return (
    <Card title="Customer messages">
      <Alert tone="info">
        These messages are recorded but not delivered: no e-mail connector is configured yet.
      </Alert>
      <DataTable
        caption="Customer messages"
        rows={o.messages}
        rowKey={(m) => m.id}
        empty={<EmptyState title="No messages" />}
        columns={[
          {
            key: 'when',
            header: 'When',
            render: (m) => formatDateTime(m.createdAt, context.tenant.timezone),
          },
          { key: 'to', header: 'To', render: (m) => m.recipient },
          { key: 'subj', header: 'Subject', render: (m) => m.subject },
          { key: 'st', header: 'Status', render: (m) => <Status value={m.status} /> },
        ]}
      />
    </Card>
  );
}
