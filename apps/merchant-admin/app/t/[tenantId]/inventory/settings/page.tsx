'use client';

import type { ChannelStockLocations, StockSettings } from '@uc/contracts';
import {
  Alert,
  Button,
  Card,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  TextField,
  formatDateTime,
  useUnsavedChangesWarning,
} from '@uc/ui';
import { useEffect, useState } from 'react';
import { serverErrors } from '../../../../../lib/forms';
import { InventoryTabs, useInventoryAction, useLocations } from '../../../../../lib/inventory';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

export default function InventorySettingsPage() {
  const { can, context, api } = useTenant();
  const enabled = can('inventory.read') && context.features.includes('inventory');
  const tz = context.tenant.timezone;
  const settings = useTenantQuery<StockSettings>(
    ['inventory', 'settings'],
    '/v1/admin/inventory/settings',
    undefined,
    enabled,
  );
  const channels = useTenantQuery<{ items: ChannelStockLocations[] }>(
    ['inventory', 'channels'],
    '/v1/admin/inventory/channels',
    undefined,
    enabled,
  );
  const locations = useLocations(enabled);
  const [form, setForm] = useState({ defaultBuffer: '', reservationTtlMinutes: '', lowStockThreshold: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (settings.data)
      setForm({
        defaultBuffer: settings.data.defaultBuffer.replace(/\.?0+$/, ''),
        reservationTtlMinutes: String(settings.data.reservationTtlMinutes),
        lowStockThreshold: settings.data.lowStockThreshold.replace(/\.?0+$/, ''),
      });
  }, [settings.data]);
  useEffect(() => {
    if (channels.data)
      setLinks(Object.fromEntries(channels.data.items.map((c) => [c.channelId, c.locationIds])));
  }, [channels.data]);
  const dirty =
    !!settings.data &&
    (form.reservationTtlMinutes !== String(settings.data.reservationTtlMinutes) ||
      form.defaultBuffer !== settings.data.defaultBuffer.replace(/\.?0+$/, '') ||
      form.lowStockThreshold !== settings.data.lowStockThreshold.replace(/\.?0+$/, ''));
  useUnsavedChangesWarning(dirty);

  const save = useInventoryAction(
    () =>
      api<StockSettings>('/v1/admin/inventory/settings', {
        method: 'PUT',
        body: {
          version: settings.data!.version,
          defaultBuffer: form.defaultBuffer || '0',
          lowStockThreshold: form.lowStockThreshold || '0',
          reservationTtlMinutes: /^\d+$/.test(form.reservationTtlMinutes)
            ? Number.parseInt(form.reservationTtlMinutes, 10)
            : -1,
        },
      }),
    'Stock settings saved',
    () => {
      setErrors({});
      setMessage(null);
    },
  );
  const saveChannel = useInventoryAction(
    (channelId: string) =>
      api<ChannelStockLocations>(`/v1/admin/inventory/channels/${channelId}/locations`, {
        method: 'PUT',
        body: { locationIds: links[channelId] ?? [] },
      }),
    (c) => `Stock locations saved for ${c.name}`,
  );

  if (!enabled) return <ForbiddenState />;
  if (settings.isLoading) return <LoadingState />;
  if (settings.error) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  const canEdit = can('inventory.adjust');
  const canChannels = can('stores.manage') && context.membership.locationScope === null;
  return (
    <>
      <PageHeader
        title="Inventory settings"
        description="Defaults for every variant; a variant’s own stock settings override them."
      />
      <InventoryTabs />
      <Card title="Availability defaults">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined, {
              onError: (err) => {
                const { fields, message: m } = serverErrors(err);
                setErrors(fields);
                setMessage(m);
              },
            });
          }}
        >
          <div className="uc-form-grid">
            <TextField
              label="Default safety buffer"
              inputMode="decimal"
              value={form.defaultBuffer}
              disabled={!canEdit}
              onChange={(e) => setForm({ ...form, defaultBuffer: e.target.value })}
              error={errors.defaultBuffer}
              hint="Units held back from ATP for every variant without its own buffer."
            />
            <TextField
              label="Hold time limit (minutes)"
              inputMode="numeric"
              value={form.reservationTtlMinutes}
              disabled={!canEdit}
              onChange={(e) => setForm({ ...form, reservationTtlMinutes: e.target.value })}
              error={errors.reservationTtlMinutes}
              hint="1 to 10080 (7 days). Expired holds return to stock automatically."
            />
            <TextField
              label="Low-stock threshold"
              inputMode="decimal"
              value={form.lowStockThreshold}
              disabled={!canEdit}
              onChange={(e) => setForm({ ...form, lowStockThreshold: e.target.value })}
              error={errors.lowStockThreshold}
            />
            <div className="uc-field">
              <span className="uc-label">Backorders</span>
              <span>Disabled — stock can never be sold below zero.</span>
            </div>
          </div>
          {message && <Alert tone="danger">{message}</Alert>}
          {canEdit && (
            <div className="uc-row">
              <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>
                Save
              </Button>
              <span className="uc-muted">Last changed {formatDateTime(settings.data!.updatedAt, tz)}</span>
            </div>
          )}
        </form>
      </Card>
      <Card title="Channel stock locations">
        <p className="uc-muted">
          Choose which locations’ stock each channel may sell. With none selected, every active location
          counts.
        </p>
        {channels.isLoading ? (
          <LoadingState rows={2} />
        ) : (
          (channels.data?.items ?? []).map((c) => (
            <fieldset key={c.channelId} className="uc-fieldset">
              <legend>{c.name}</legend>
              <div className="uc-row" style={{ flexWrap: 'wrap' }}>
                {locations.locations
                  .filter((l) => l.status === 'active')
                  .map((l) => (
                    <label key={l.id} className="uc-checkbox">
                      <input
                        type="checkbox"
                        disabled={!canChannels}
                        checked={(links[c.channelId] ?? []).includes(l.id)}
                        onChange={(e) =>
                          setLinks((s) => ({
                            ...s,
                            [c.channelId]: e.target.checked
                              ? [...(s[c.channelId] ?? []), l.id]
                              : (s[c.channelId] ?? []).filter((x) => x !== l.id),
                          }))
                        }
                      />
                      {l.name}
                    </label>
                  ))}
                {canChannels && (
                  <Button
                    size="sm"
                    loading={saveChannel.isPending && saveChannel.variables === c.channelId}
                    onClick={() => saveChannel.mutate(c.channelId)}
                  >
                    Save {c.name}
                  </Button>
                )}
              </div>
            </fieldset>
          ))
        )}
        {saveChannel.error && (
          <Alert tone="danger">{serverErrors(saveChannel.error).message ?? 'Could not save'}</Alert>
        )}
      </Card>
    </>
  );
}
