'use client';

import type { StockLevel, Transfer, VariantStock } from '@uc/contracts';
import {
  Alert,
  Button,
  Card,
  ForbiddenState,
  PageHeader,
  SelectField,
  TextField,
  newIdempotencyKey,
  useUnsavedChangesWarning,
} from '@uc/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { serverErrors } from '../../../../../../lib/forms';
import {
  InventoryTabs,
  VariantPicker,
  qtyText,
  useInventoryAction,
  useLocations,
} from '../../../../../../lib/inventory';
import { useTenant } from '../../../../../../lib/tenant';

interface Line {
  variant: StockLevel;
  quantity: string;
  serialItemId: string;
  pieces: VariantStock['pieces'];
}

export default function NewTransferPage() {
  const { can, tenantId, context, api } = useTenant();
  const router = useRouter();
  const enabled = can('inventory.transfer') && context.features.includes('inventory');
  const locations = useLocations(enabled);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [key] = useState(newIdempotencyKey());
  useUnsavedChangesWarning(lines.length > 0);

  const create = useInventoryAction(
    () =>
      api<Transfer>('/v1/admin/inventory/transfers', {
        method: 'POST',
        idempotencyKey: key,
        body: {
          fromLocationId: fromId,
          toLocationId: toId,
          note: note || undefined,
          lines: lines.map((l) =>
            l.variant.tracking === 'serial'
              ? { variantId: l.variant.variantId, serialItemId: l.serialItemId }
              : { variantId: l.variant.variantId, quantity: l.quantity },
          ),
        },
      }),
    (t) => `Transfer ${t.number} dispatched`,
    (t) => {
      setLines([]);
      router.push(`/t/${tenantId}/inventory/transfers/${t.id}`);
    },
  );

  const add = async (variant: StockLevel) => {
    const detail =
      variant.tracking === 'serial'
        ? await api<VariantStock>(`/v1/admin/inventory/variants/${variant.variantId}`)
        : null;
    setLines((ls) => [...ls, { variant, quantity: '1', serialItemId: '', pieces: detail?.pieces ?? [] }]);
  };
  const update = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  if (!enabled) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="New transfer"
        description="Dispatching removes stock from the source immediately; the destination receives it later."
      />
      <InventoryTabs />
      <Card title="Route">
        <div className="uc-form-grid">
          <SelectField
            label="From"
            value={fromId}
            onChange={(e) => setFromId(e.target.value)}
            error={errors.fromLocationId}
            options={[{ value: '', label: 'Choose…' }, ...locations.options]}
          />
          <SelectField
            label="To"
            value={toId}
            onChange={(e) => setToId(e.target.value)}
            error={errors.toLocationId}
            options={[
              { value: '', label: 'Choose…' },
              ...locations.options.filter((o) => o.value !== fromId),
            ]}
          />
          <TextField label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </Card>
      <Card title="Lines">
        <VariantPicker
          onPick={(v) => void add(v)}
          exclude={lines.filter((l) => l.variant.tracking !== 'serial').map((l) => l.variant.variantId)}
        />
        {lines.length === 0 ? (
          <p className="uc-muted">Add at least one SKU.</p>
        ) : (
          <div className="uc-table-wrap">
            <table className="uc-table">
              <caption className="uc-sr-only">Transfer lines</caption>
              <thead>
                <tr>
                  <th scope="col">SKU</th>
                  <th scope="col">Quantity / piece</th>
                  <th scope="col">ATP (all locations)</th>
                  <th scope="col">
                    <span className="uc-sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={`${l.variant.variantId}-${i}`}>
                    <td className="uc-mono">{l.variant.sku}</td>
                    <td>
                      {l.variant.tracking === 'serial' ? (
                        <SelectField
                          label={`Piece for ${l.variant.sku}`}
                          hideLabel
                          value={l.serialItemId}
                          onChange={(e) => update(i, { serialItemId: e.target.value })}
                          error={errors[`lines.${i}.serialItemId`]}
                          options={[
                            { value: '', label: 'Choose piece…' },
                            ...l.pieces
                              .filter((p) => p.stockState === 'in_stock' && p.location?.id === fromId)
                              .map((p) => ({ value: p.id, label: p.serialTag })),
                          ]}
                        />
                      ) : (
                        <TextField
                          label={`Quantity of ${l.variant.sku}`}
                          inputMode="decimal"
                          value={l.quantity}
                          onChange={(e) => update(i, { quantity: e.target.value })}
                          error={errors[`lines.${i}.quantity`]}
                        />
                      )}
                    </td>
                    <td>{qtyText(l.variant.atp, l.variant.unit)}</td>
                    <td>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {message && <Alert tone="danger">{message}</Alert>}
        <div className="uc-row">
          <Button
            variant="primary"
            disabled={!fromId || !toId || lines.length === 0}
            loading={create.isPending}
            onClick={() =>
              create.mutate(undefined, {
                onError: (e) => {
                  const { fields, message: m } = serverErrors(e);
                  setErrors(fields);
                  setMessage(m);
                },
              })
            }
          >
            Dispatch transfer
          </Button>
        </div>
      </Card>
    </>
  );
}
