'use client';

import type { Rfq } from '@uc/contracts';
import { Alert, Button, Card, PageHeader, SelectField, TextField, errorMessage } from '@uc/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { buyerApi, useBuyer } from '../../../../lib/buyer';

/** "SKU, qty, optional note" per row. */
function parse(text: string) {
  const lines: { sku: string; serialTag: null; quantity: number; note: string | null }[] = [];
  const errors: string[] = [];
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((row, i) => {
      const [sku, qty, ...rest] = row.split(',').map((p) => p.trim());
      if (!sku) return;
      const quantity = qty ? Number.parseInt(qty, 10) : 1;
      if (!/^\d{1,6}$/.test(qty ?? '1') || quantity < 1)
        errors.push(`Row ${i + 1}: quantity must be a whole number of at least 1`);
      else lines.push({ sku, serialTag: null, quantity, note: rest.join(', ') || null });
    });
  return { lines, errors };
}

export default function NewRfqPage() {
  const { me } = useBuyer();
  const router = useRouter();
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [neededBy, setNeededBy] = useState('');
  const [locationId, setLocationId] = useState(me.company?.locations[0]?.id ?? '');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  async function submit() {
    const parsed = parse(text);
    setErrors(parsed.errors);
    if (parsed.errors.length) return;
    if (!parsed.lines.length) return setErrors(['Add at least one line']);
    setBusy(true);
    try {
      const rfq = await buyerApi<Rfq>('/rfqs', {
        method: 'POST',
        body: {
          lines: parsed.lines,
          note: note.trim() || null,
          locationId: locationId || null,
          neededBy: neededBy ? new Date(`${neededBy}T00:00:00Z`).toISOString() : null,
        },
      });
      router.push(`/rfqs/${rfq.id}`);
    } catch (e) {
      setErrors([errorMessage(e)]);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        title="New request for quotation"
        description="Your supplier reviews the request and replies with a quotation."
      />
      <Card title="What do you need?">
        <label className="uc-field">
          <span className="uc-label">Lines</span>
          <textarea
            className="uc-input"
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'AUR-BAND22-12, 50, matte finish'}
            aria-describedby="rfq-hint"
          />
          <span id="rfq-hint" className="uc-hint">
            One per row: SKU, quantity, and an optional note.
          </span>
        </label>
        <div className="uc-form-grid">
          <SelectField
            label="Deliver to"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            options={(me.company?.locations ?? []).map((l) => ({ value: l.id, label: l.name }))}
          />
          <TextField
            label="Needed by (optional)"
            type="date"
            value={neededBy}
            onChange={(e) => setNeededBy(e.target.value)}
          />
        </div>
        <label className="uc-field">
          <span className="uc-label">Note to supplier (optional)</span>
          <textarea
            className="uc-input"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
          />
        </label>
        {errors.map((p) => (
          <Alert key={p} tone="danger">
            {p}
          </Alert>
        ))}
        <div className="uc-row">
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Send request
          </Button>
        </div>
      </Card>
    </>
  );
}
