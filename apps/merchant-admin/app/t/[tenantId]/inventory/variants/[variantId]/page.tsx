'use client';

import type {
  Page,
  Reservation,
  StockMovement,
  StockOperationResult,
  VariantStock,
  VariantStockSettings,
} from '@uc/contracts';
import {
  Alert,
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
  newIdempotencyKey,
  useCursorPagination,
} from '@uc/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { serverErrors } from '../../../../../../lib/forms';
import {
  ADJUSTMENT_REASON_OPTIONS,
  InventoryTabs,
  MOVEMENT_LABELS,
  qtyText,
  useInventoryAction,
  useLocations,
} from '../../../../../../lib/inventory';
import { useTenant, useTenantQuery } from '../../../../../../lib/tenant';
import { grams } from '../../../../../../lib/weight';

type Dialogs = 'receive' | 'adjust' | 'condition' | 'hold' | 'settings' | null;

const CONDITIONS = [
  { value: 'sellable', label: 'Sellable' },
  { value: 'damaged', label: 'Damaged' },
  { value: 'quarantine', label: 'Quarantine' },
];

export default function VariantStockPage() {
  const { variantId } = useParams<{ variantId: string }>();
  const { can, tenantId, context, api } = useTenant();
  const enabled = can('inventory.read') && context.features.includes('inventory');
  const tz = context.tenant.timezone;
  const stock = useTenantQuery<VariantStock>(
    ['inventory', 'variant', variantId],
    `/v1/admin/inventory/variants/${variantId}`,
    undefined,
    enabled,
  );
  const holds = useTenantQuery<Page<Reservation>>(
    ['inventory', 'reservations', 'variant', variantId],
    '/v1/admin/inventory/reservations',
    { variantId, limit: 50 },
    enabled,
  );
  const pager = useCursorPagination(variantId);
  const ledger = useTenantQuery<Page<StockMovement>>(
    ['inventory', 'movements', 'variant', variantId],
    '/v1/admin/inventory/movements',
    { variantId, cursor: pager.cursor, limit: 15 },
    enabled,
  );
  const locations = useLocations(enabled);
  const [open, setOpen] = useState<Dialogs>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [piecesToReceive, setPiecesToReceive] = useState<string[]>([]);
  const [writeOff, setWriteOff] = useState<{ id: string; tag: string } | null>(null);
  const [release, setRelease] = useState<Reservation | null>(null);
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const show = (d: Dialogs, initial: Record<string, string> = {}) => {
    setForm(initial);
    setFieldErrors({});
    setFormError(null);
    setPiecesToReceive([]);
    setIdemKey(newIdempotencyKey());
    setOpen(d);
  };
  const close = () => setOpen(null);
  const fail = (e: unknown) => {
    const { fields, message } = serverErrors(e);
    setFieldErrors(fields);
    setFormError(message ?? (Object.keys(fields).length ? null : errorMessage(e)));
  };
  const op = (label: string) => (r: StockOperationResult) =>
    `${label}: ${r.movements.length} ledger line(s) posted`;

  const receive = useInventoryAction(
    () => {
      const serial = stock.data!.settings.tracking === 'serial' || piecesToReceive.length > 0;
      return api<StockOperationResult>('/v1/admin/inventory/receipts', {
        method: 'POST',
        idempotencyKey: idemKey,
        body: {
          locationId: form.locationId,
          condition: serial ? 'sellable' : (form.condition ?? 'sellable'),
          reference: form.reference || undefined,
          note: form.note || undefined,
          lines: [
            serial ? { variantId, serialItemIds: piecesToReceive } : { variantId, quantity: form.quantity },
          ],
        },
      });
    },
    op('Stock received'),
    close,
  );
  const adjust = useInventoryAction(
    () =>
      api<StockOperationResult>('/v1/admin/inventory/adjustments', {
        method: 'POST',
        idempotencyKey: idemKey,
        body: {
          locationId: form.locationId,
          condition: form.condition ?? 'sellable',
          reasonCode: form.reasonCode ?? 'count_correction',
          note: form.note ?? '',
          lines: [{ variantId, delta: form.delta }],
        },
      }),
    op('Stock adjusted'),
    close,
  );
  const changeCondition = useInventoryAction(
    () =>
      api<StockOperationResult>('/v1/admin/inventory/condition-changes', {
        method: 'POST',
        body: {
          locationId: form.locationId,
          variantId,
          from: form.from ?? 'sellable',
          to: form.to ?? 'damaged',
          quantity: form.quantity,
          note: form.note ?? '',
        },
      }),
    op('Condition changed'),
    close,
  );
  const hold = useInventoryAction(
    () =>
      api<Reservation>('/v1/admin/inventory/reservations', {
        method: 'POST',
        idempotencyKey: idemKey,
        body: {
          variantId,
          quantity: form.serialItemId ? '1' : form.quantity,
          locationId: form.locationId || undefined,
          serialItemId: form.serialItemId || undefined,
          ttlMinutes: form.ttl ? Number.parseInt(form.ttl, 10) : undefined,
          note: form.note || undefined,
        },
      }),
    (r) =>
      `Held ${r.serialItem ? r.serialItem.serialTag : qtyText(r.quantity, stock.data?.settings.unit)} at ${r.location.name} until ${formatDateTime(r.expiresAt!, tz)}`,
    close,
  );
  const saveSettings = useInventoryAction(
    () =>
      api<VariantStockSettings>(`/v1/admin/inventory/variants/${variantId}/settings`, {
        method: 'PUT',
        body: {
          version: stock.data!.settings.version,
          tracking: form.tracking,
          unit: form.unit,
          buffer: form.buffer === '' ? null : form.buffer,
          lowStockThreshold: form.lowStockThreshold === '' ? null : form.lowStockThreshold,
        },
      }),
    'Stock settings saved',
    close,
  );
  const doWriteOff = useInventoryAction(
    (reason: string) =>
      api<StockOperationResult>(`/v1/admin/inventory/serial-items/${writeOff!.id}/write-off`, {
        method: 'POST',
        body: { reason },
      }),
    'Piece written off',
    () => setWriteOff(null),
  );
  const commit = useInventoryAction(
    (id: string) => api<Reservation>(`/v1/admin/inventory/reservations/${id}/commit`, { method: 'POST' }),
    'Hold committed',
  );
  const doRelease = useInventoryAction(
    (reason: string) =>
      api<Reservation>(`/v1/admin/inventory/reservations/${release!.id}/release`, {
        method: 'POST',
        body: { reason: reason || undefined },
      }),
    'Reservation released',
    () => setRelease(null),
  );

  if (!enabled) return <ForbiddenState />;
  if (stock.isLoading) return <LoadingState />;
  if (stock.error) return <ErrorState error={stock.error} onRetry={() => void stock.refetch()} />;
  const v = stock.data!;
  const unit = v.settings.unit;
  const serial = v.settings.tracking === 'serial';
  const canAdjust = can('inventory.adjust');
  const canReserve = can('inventory.reserve');
  const receivable = v.pieces.filter((p) => p.stockState === 'not_received' && p.status === 'active');
  const activeHolds = (holds.data?.items ?? []).filter(
    (r) => r.status === 'held' || r.status === 'committed',
  );
  const pending =
    receive.isPending ||
    adjust.isPending ||
    changeCondition.isPending ||
    hold.isPending ||
    saveSettings.isPending;

  const submit = () => {
    const actions = { receive, adjust, condition: changeCondition, hold, settings: saveSettings } as const;
    if (!open) return;
    actions[open].mutate(undefined as never, { onError: fail });
  };

  return (
    <>
      <PageHeader
        title={`${v.sku} stock`}
        description={
          <>
            {v.productTitle}
            {v.variantTitle ? ` · ${v.variantTitle}` : ''} ·{' '}
            <Link href={`/t/${tenantId}/products/${v.productId}`}>Product</Link>
          </>
        }
        actions={
          <>
            {canAdjust && (
              <>
                <Button variant="primary" onClick={() => show('receive', { condition: 'sellable' })}>
                  Receive stock
                </Button>
                {!serial && (
                  <Button
                    onClick={() => show('adjust', { condition: 'sellable', reasonCode: 'count_correction' })}
                  >
                    Adjust
                  </Button>
                )}
                {!serial && (
                  <Button onClick={() => show('condition', { from: 'sellable', to: 'damaged' })}>
                    Change condition
                  </Button>
                )}
              </>
            )}
            {canReserve && !serial && (
              <Button onClick={() => show('hold', { quantity: '1' })}>Hold stock</Button>
            )}
          </>
        }
      />
      <InventoryTabs />
      <section className="uc-grid" aria-label="Availability">
        <div className="uc-card uc-stat">
          <span className="uc-muted">Available to promise</span>
          <strong>{qtyText(v.atp.total, unit)}</strong>
          <span className="uc-muted">
            buffer {serial ? 'n/a for pieces' : qtyText(v.settings.effectiveBuffer, unit)}
          </span>
        </div>
        {v.atp.byChannel.map((c) => (
          <div key={c.channelId} className="uc-card uc-stat">
            <span className="uc-muted">ATP · {c.name}</span>
            <strong>{qtyText(c.atp, unit)}</strong>
          </div>
        ))}
      </section>

      <Card
        title="Balances by location"
        actions={
          canAdjust && (
            <Button
              size="sm"
              onClick={() =>
                show('settings', {
                  tracking: v.settings.tracking,
                  unit: v.settings.unit,
                  buffer: v.settings.buffer ?? '',
                  lowStockThreshold: v.settings.lowStockThreshold ?? '',
                })
              }
            >
              Stock settings
            </Button>
          )
        }
      >
        <p className="uc-muted">
          Tracking: <strong>{serial ? 'by piece' : `by quantity (${unit})`}</strong> · Low-stock threshold{' '}
          {qtyText(v.settings.effectiveLowStockThreshold, unit)}
          {v.settings.buffer === null ? ' · buffer from tenant default' : ''}
        </p>
        <DataTable
          caption="Balances"
          rows={v.balances}
          rowKey={(b) => `${b.location.id}-${b.condition}`}
          empty={<EmptyState title="No stock yet" description="Receive stock to create the first balance." />}
          columns={[
            { key: 'loc', header: 'Location', render: (b) => b.location.name },
            { key: 'cond', header: 'Condition', render: (b) => <StatusBadge status={b.condition} /> },
            { key: 'oh', header: 'On hand', render: (b) => qtyText(b.onHand, unit) },
            { key: 'res', header: 'Held', render: (b) => qtyText(b.reserved, unit) },
            { key: 'com', header: 'Committed', render: (b) => qtyText(b.committed, unit) },
            {
              key: 'av',
              header: 'Available',
              render: (b) => (b.condition === 'sellable' ? qtyText(b.available, unit) : '—'),
            },
            { key: 'at', header: 'Updated', render: (b) => formatDateTime(b.updatedAt, tz) },
          ]}
        />
      </Card>

      {(serial || v.pieces.length > 0) && (
        <Card title="Pieces">
          <DataTable
            caption="Serialized pieces"
            rows={v.pieces}
            rowKey={(p) => p.id}
            empty={
              <EmptyState title="No pieces" description="Add pieces from the product’s measurements card." />
            }
            columns={[
              {
                key: 'tag',
                header: 'Tag',
                render: (p) => (
                  <Link href={`/t/${tenantId}/serial-items/${p.id}`} className="uc-mono">
                    {p.serialTag}
                  </Link>
                ),
              },
              { key: 'huid', header: 'HUID', render: (p) => p.huid ?? '—' },
              { key: 'gross', header: 'Gross', render: (p) => grams(p.grossG) },
              { key: 'state', header: 'Stock', render: (p) => <StatusBadge status={p.stockState} /> },
              { key: 'loc', header: 'Location', render: (p) => p.location?.name ?? '—' },
              {
                key: 'act',
                header: 'Actions',
                render: (p) =>
                  p.stockState === 'in_stock' ? (
                    <span className="uc-row">
                      {canReserve && p.status === 'active' && (
                        <Button
                          size="sm"
                          onClick={() => show('hold', { serialItemId: p.id, tag: p.serialTag })}
                        >
                          Hold
                        </Button>
                      )}
                      {canAdjust && (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => setWriteOff({ id: p.id, tag: p.serialTag })}
                        >
                          Write off
                        </Button>
                      )}
                    </span>
                  ) : p.status !== 'active' ? (
                    <StatusBadge status={p.status} />
                  ) : null,
              },
            ]}
          />
        </Card>
      )}

      <Card title="Active holds and commitments">
        <DataTable
          caption="Reservations"
          rows={holds.data ? activeHolds : undefined}
          isLoading={holds.isLoading}
          error={holds.error}
          rowKey={(r) => r.id}
          empty={
            <EmptyState
              title="No active holds"
              description="Holds expire automatically after their time limit."
            />
          }
          columns={[
            {
              key: 'qty',
              header: 'Quantity',
              render: (r) => (r.serialItem ? r.serialItem.serialTag : qtyText(r.quantity, unit)),
            },
            { key: 'loc', header: 'Location', render: (r) => r.location.name },
            { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            {
              key: 'exp',
              header: 'Expires',
              render: (r) => (r.status === 'held' && r.expiresAt ? formatDateTime(r.expiresAt, tz) : '—'),
            },
            { key: 'by', header: 'By', render: (r) => r.createdBy?.name ?? 'System' },
            {
              key: 'act',
              header: 'Actions',
              render: (r) =>
                canReserve ? (
                  <span className="uc-row">
                    {r.status === 'held' && (
                      <Button
                        size="sm"
                        loading={commit.isPending && commit.variables === r.id}
                        onClick={() => commit.mutate(r.id)}
                      >
                        Commit
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setRelease(r)}>
                      Release
                    </Button>
                  </span>
                ) : null,
            },
          ]}
        />
        {commit.error && <Alert tone="danger">{errorMessage(commit.error)}</Alert>}
      </Card>

      <Card
        title="Ledger"
        actions={<Link href={`/t/${tenantId}/inventory/movements?variantId=${variantId}`}>Full ledger</Link>}
      >
        <DataTable
          caption="Stock movements"
          rows={ledger.data?.items}
          isLoading={ledger.isLoading}
          error={ledger.error}
          rowKey={(m) => m.id}
          pagination={pager.controls(ledger.data?.nextCursor)}
          empty={
            <EmptyState title="No movements yet" description="Every stock change will be listed here." />
          }
          columns={[
            { key: 'at', header: 'When', render: (m) => formatDateTime(m.occurredAt, tz) },
            { key: 'type', header: 'Type', render: (m) => MOVEMENT_LABELS[m.type] ?? m.type },
            {
              key: 'loc',
              header: 'Location',
              render: (m) => `${m.location.name} · ${m.condition.replace('_', ' ')}`,
            },
            { key: 'oh', header: 'On hand Δ', render: (m) => signed(m.onHandDelta, unit) },
            { key: 'res', header: 'Held Δ', render: (m) => signed(m.reservedDelta, unit) },
            { key: 'com', header: 'Committed Δ', render: (m) => signed(m.committedDelta, unit) },
            {
              key: 'ref',
              header: 'Reference / note',
              render: (m) => (
                <>
                  {m.serialItem && <span className="uc-mono">{m.serialItem.serialTag} </span>}
                  {m.reference && <span className="uc-mono">{m.reference} </span>}
                  {m.reasonCode && <Badge>{m.reasonCode.replace(/_/g, ' ')}</Badge>} {m.note}
                </>
              ),
            },
            { key: 'by', header: 'By', render: (m) => m.actor?.name ?? 'System' },
          ]}
        />
      </Card>

      <Dialog
        open={open !== null}
        title={
          open === 'receive'
            ? 'Receive stock'
            : open === 'adjust'
              ? 'Adjust stock'
              : open === 'condition'
                ? 'Change condition'
                : open === 'hold'
                  ? form.tag
                    ? `Hold piece ${form.tag}`
                    : 'Hold stock'
                  : 'Stock settings'
        }
        onClose={close}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" loading={pending} onClick={submit}>
              {open === 'hold' ? 'Hold' : open === 'settings' ? 'Save' : 'Post'}
            </Button>
          </>
        }
      >
        <div className="uc-stack">
          {open !== 'settings' && !(open === 'hold' && form.serialItemId) && (
            <SelectField
              label={open === 'hold' ? 'Location (optional)' : 'Location'}
              value={form.locationId ?? ''}
              onChange={(e) => set('locationId', e.target.value)}
              error={fieldErrors.locationId}
              options={[
                { value: '', label: open === 'hold' ? 'Best available location' : 'Choose…' },
                ...locations.options,
              ]}
            />
          )}
          {open === 'receive' &&
            (serial ? (
              <fieldset className="uc-fieldset">
                <legend>Pieces arriving</legend>
                {receivable.length === 0 ? (
                  <p className="uc-muted">
                    No active pieces are waiting to be received. Add pieces on the product page first.
                  </p>
                ) : (
                  receivable.map((p) => (
                    <label key={p.id} className="uc-checkbox">
                      <input
                        type="checkbox"
                        checked={piecesToReceive.includes(p.id)}
                        onChange={(e) =>
                          setPiecesToReceive((s) =>
                            e.target.checked ? [...s, p.id] : s.filter((x) => x !== p.id),
                          )
                        }
                      />
                      <span className="uc-mono">{p.serialTag}</span> · {grams(p.grossG)}
                    </label>
                  ))
                )}
                {fieldErrors['lines.0.serialItemIds'] && (
                  <span className="uc-error">{fieldErrors['lines.0.serialItemIds']}</span>
                )}
              </fieldset>
            ) : (
              <>
                <TextField
                  label={`Quantity (${unit})`}
                  inputMode="decimal"
                  value={form.quantity ?? ''}
                  onChange={(e) => set('quantity', e.target.value)}
                  error={fieldErrors['lines.0.quantity']}
                />
                <SelectField
                  label="Condition"
                  value={form.condition ?? 'sellable'}
                  onChange={(e) => set('condition', e.target.value)}
                  options={CONDITIONS}
                />
              </>
            ))}
          {open === 'receive' && (
            <TextField
              label="Reference (GRN / delivery note)"
              value={form.reference ?? ''}
              onChange={(e) => set('reference', e.target.value)}
              error={fieldErrors.reference}
              hint="A reference can only be posted once, so a re-sent receipt never double counts."
            />
          )}
          {open === 'adjust' && (
            <>
              <TextField
                label={`Change (${unit}, negative to remove)`}
                inputMode="decimal"
                value={form.delta ?? ''}
                onChange={(e) => set('delta', e.target.value)}
                error={fieldErrors['lines.0.delta']}
              />
              <SelectField
                label="Condition"
                value={form.condition ?? 'sellable'}
                onChange={(e) => set('condition', e.target.value)}
                options={CONDITIONS}
              />
              <SelectField
                label="Reason"
                value={form.reasonCode ?? 'count_correction'}
                onChange={(e) => set('reasonCode', e.target.value)}
                options={ADJUSTMENT_REASON_OPTIONS}
              />
            </>
          )}
          {open === 'condition' && (
            <>
              <SelectField
                label="From"
                value={form.from ?? 'sellable'}
                onChange={(e) => set('from', e.target.value)}
                options={CONDITIONS}
              />
              <SelectField
                label="To"
                value={form.to ?? 'damaged'}
                onChange={(e) => set('to', e.target.value)}
                options={CONDITIONS}
                error={fieldErrors.to}
              />
              <TextField
                label={`Quantity (${unit})`}
                inputMode="decimal"
                value={form.quantity ?? ''}
                onChange={(e) => set('quantity', e.target.value)}
                error={fieldErrors.quantity}
              />
            </>
          )}
          {open === 'hold' && (
            <>
              {!form.serialItemId && (
                <TextField
                  label={`Quantity (${unit})`}
                  inputMode="decimal"
                  value={form.quantity ?? ''}
                  onChange={(e) => set('quantity', e.target.value)}
                  error={fieldErrors.quantity}
                />
              )}
              <TextField
                label="Hold for (minutes)"
                inputMode="numeric"
                value={form.ttl ?? ''}
                onChange={(e) => set('ttl', e.target.value)}
                hint="Leave empty for the tenant default. Expired holds return to stock automatically."
              />
            </>
          )}
          {open === 'settings' && (
            <>
              <SelectField
                label="Tracking"
                value={form.tracking ?? 'quantity'}
                onChange={(e) => set('tracking', e.target.value)}
                options={[
                  { value: 'quantity', label: 'By quantity' },
                  ...(context.features.includes('serialized_items')
                    ? [{ value: 'serial', label: 'By piece (serialized)' }]
                    : []),
                ]}
                hint="Tracking and unit can only change before the first stock movement."
              />
              <SelectField
                label="Unit"
                value={form.unit ?? 'pcs'}
                onChange={(e) => set('unit', e.target.value)}
                options={[
                  { value: 'pcs', label: 'Pieces (whole numbers)' },
                  { value: 'g', label: 'Grams (bulk metal, chains by weight)' },
                ]}
              />
              <TextField
                label="Safety buffer"
                inputMode="decimal"
                value={form.buffer ?? ''}
                onChange={(e) => set('buffer', e.target.value)}
                hint="Held back from ATP. Empty = tenant default."
                error={fieldErrors.buffer}
              />
              <TextField
                label="Low-stock threshold"
                inputMode="decimal"
                value={form.lowStockThreshold ?? ''}
                onChange={(e) => set('lowStockThreshold', e.target.value)}
                hint="Empty = tenant default."
                error={fieldErrors.lowStockThreshold}
              />
            </>
          )}
          {open !== 'settings' && (
            <TextField
              label={
                open === 'adjust' || open === 'condition'
                  ? 'Note (required, recorded in the audit log)'
                  : 'Note'
              }
              value={form.note ?? ''}
              onChange={(e) => set('note', e.target.value)}
              error={fieldErrors.note}
            />
          )}
          {formError && <Alert tone="danger">{formError}</Alert>}
        </div>
      </Dialog>

      <ConfirmDialog
        open={writeOff !== null}
        title={`Write off ${writeOff?.tag ?? ''}`}
        description="The piece leaves stock permanently (lost, destroyed or melted). This is recorded in the ledger and audit log."
        confirmLabel="Write off"
        requireReason
        loading={doWriteOff.isPending}
        error={doWriteOff.error ? errorMessage(doWriteOff.error) : null}
        onConfirm={(reason) => doWriteOff.mutate(reason)}
        onClose={() => setWriteOff(null)}
      />
      <ConfirmDialog
        open={release !== null}
        title="Release reservation"
        description={
          release?.status === 'committed'
            ? 'This stock was committed (e.g. to an order). Releasing returns it to available stock.'
            : 'The held stock returns to available stock immediately.'
        }
        confirmLabel="Release"
        requireReason={release?.status === 'committed'}
        loading={doRelease.isPending}
        error={doRelease.error ? errorMessage(doRelease.error) : null}
        onConfirm={(reason) => doRelease.mutate(reason)}
        onClose={() => setRelease(null)}
      />
    </>
  );
}

function signed(value: string, unit: 'pcs' | 'g') {
  if (/^0(\.0+)?$/.test(value)) return <span className="uc-muted">·</span>;
  const negative = value.startsWith('-');
  const text = qtyText(negative ? value.slice(1) : value, unit);
  return (
    <span style={{ color: negative ? 'var(--uc-danger, #b42318)' : 'var(--uc-success, #067647)' }}>
      {negative ? `−${text}` : `+${text}`}
    </span>
  );
}
