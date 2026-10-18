'use client';

import type { StockCount, StockLevel } from '@uc/contracts';
import {
  Alert,
  Button,
  Card,
  ForbiddenState,
  PageHeader,
  SelectField,
  TextField,
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

/** Local wall-clock value for <input type="datetime-local"> (minutes precision). */
function localNow(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function NewCountPage() {
  const { can, tenantId, context, api } = useTenant();
  const router = useRouter();
  const enabled = can('inventory.adjust') && context.features.includes('inventory');
  const locations = useLocations(enabled);
  const [locationId, setLocationId] = useState('');
  const [asOf, setAsOf] = useState(localNow());
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<{ variant: StockLevel; counted: string }[]>([]);
  const [preview, setPreview] = useState<StockCount | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  useUnsavedChangesWarning(lines.length > 0);

  const body = (dryRun: boolean) => ({
    locationId,
    asOf: new Date(asOf).toISOString(),
    reference: reference || undefined,
    note: note || undefined,
    dryRun,
    lines: lines.map((l) => ({ variantId: l.variant.variantId, counted: l.counted })),
  });
  const onError = (e: unknown) => {
    const { fields, message: m } = serverErrors(e);
    setErrors(fields);
    setMessage(m);
  };
  const run = useInventoryAction(
    (dryRun: boolean) =>
      api<StockCount>('/v1/admin/inventory/counts', { method: 'POST', body: body(dryRun) }),
    (c) =>
      c.status === 'preview'
        ? 'Variance preview ready (nothing posted yet)'
        : c.status === 'applied'
          ? 'Stocktake applied'
          : 'Count was older than the last applied count: recorded as stale, not applied',
    (c) => {
      setErrors({});
      setMessage(null);
      if (c.status === 'preview') setPreview(c);
      else {
        setLines([]);
        router.push(`/t/${tenantId}/inventory/counts/${c.id}`);
      }
    },
  );
  const change = (i: number, counted: string) => {
    setPreview(null);
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, counted } : l)));
  };

  if (!enabled) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="New stocktake"
        description="Enter what is physically on the shelf (sellable condition). Preview the variance first; applying posts one ledger movement per difference."
      />
      <InventoryTabs />
      <Card title="Count">
        <div className="uc-form-grid">
          <SelectField
            label="Location"
            value={locationId}
            onChange={(e) => {
              setPreview(null);
              setLocationId(e.target.value);
            }}
            error={errors.locationId}
            options={[{ value: '', label: 'Choose…' }, ...locations.options]}
          />
          <TextField
            label="Counted at"
            type="datetime-local"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            error={errors.asOf}
            hint="When the count was taken, in your browser’s time zone."
          />
          <TextField
            label="Reference (count sheet)"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            error={errors.reference}
          />
          <TextField label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </Card>
      <Card title="Counted quantities">
        <VariantPicker
          onPick={(v) =>
            !lines.some((l) => l.variant.variantId === v.variantId) &&
            setLines((ls) => [...ls, { variant: v, counted: '' }])
          }
        />
        {lines.length > 0 && (
          <div className="uc-table-wrap">
            <table className="uc-table">
              <caption className="uc-sr-only">Count lines</caption>
              <thead>
                <tr>
                  <th scope="col">SKU</th>
                  <th scope="col">Counted</th>
                  <th scope="col">System (on hand)</th>
                  <th scope="col">Variance</th>
                  <th scope="col">
                    <span className="uc-sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const p = preview?.lines.find((x) => x.variantId === l.variant.variantId);
                  return (
                    <tr key={l.variant.variantId}>
                      <td className="uc-mono">{l.variant.sku}</td>
                      <td>
                        {l.variant.tracking === 'serial' ? (
                          <span className="uc-error">Tracked by piece — remove this line</span>
                        ) : (
                          <TextField
                            label={`Counted ${l.variant.sku}`}
                            inputMode="decimal"
                            value={l.counted}
                            onChange={(e) => change(i, e.target.value)}
                            error={errors[`lines.${i}.counted`] ?? errors[`lines.${i}.variantId`]}
                          />
                        )}
                      </td>
                      <td>{p ? qtyText(p.expected, l.variant.unit) : '—'}</td>
                      <td>
                        {p
                          ? p.variance.startsWith('-')
                            ? `−${qtyText(p.variance.slice(1), l.variant.unit)}`
                            : `+${qtyText(p.variance, l.variant.unit)}`
                          : '—'}
                      </td>
                      <td>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setPreview(null);
                            setLines((ls) => ls.filter((_, j) => j !== i));
                          }}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {message && <Alert tone="danger">{message}</Alert>}
        <div className="uc-row">
          <Button
            disabled={!locationId || lines.length === 0}
            loading={run.isPending && run.variables === true}
            onClick={() => run.mutate(true, { onError })}
          >
            Preview variance
          </Button>
          <Button
            variant="primary"
            disabled={!preview}
            loading={run.isPending && run.variables === false}
            onClick={() => run.mutate(false, { onError })}
          >
            Apply stocktake
          </Button>
        </div>
      </Card>
    </>
  );
}
