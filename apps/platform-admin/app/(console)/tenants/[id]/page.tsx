'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PRESETS, type FeatureKey, type TenantDetail } from '@uc/contracts';
import {
  Alert,
  apiRequest,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  SelectField,
  StatusBadge,
  TextField,
  errorMessage,
  formatDateTime,
  useToast,
} from '@uc/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { usePlatformMe, usePlatformQuery } from '../../../../lib/platform';

type Override = 'default' | 'on' | 'off';

export default function TenantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const me = usePlatformMe();
  const toast = useToast();
  const queryClient = useQueryClient();
  const tenant = usePlatformQuery<TenantDetail>(
    ['tenant', id],
    `/v1/platform/tenants/${id}`,
    undefined,
    me.can('platform.tenants.read'),
  );
  const [statusDialog, setStatusDialog] = useState<'suspend' | 'reactivate' | null>(null);
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [reason, setReason] = useState('');
  const refresh = (data: TenantDetail) => {
    queryClient.setQueryData(['p', 'tenant', id, {}], data);
    void queryClient.invalidateQueries({ queryKey: ['p', 'tenants'] });
  };

  useEffect(() => {
    if (tenant.data) {
      setOverrides(
        Object.fromEntries(
          tenant.data.entitlements.map((f) => [
            f.key,
            f.override === null ? 'default' : f.override ? 'on' : 'off',
          ]),
        ),
      );
    }
  }, [tenant.data]);

  const changeStatus = useMutation({
    mutationFn: ({ action, why }: { action: 'suspend' | 'reactivate'; why: string }) =>
      apiRequest<TenantDetail>(`/v1/platform/tenants/${id}/${action}`, {
        method: 'POST',
        body: { version: tenant.data!.version, reason: why },
      }),
    onSuccess: (data) => {
      refresh(data);
      toast(data.status === 'suspended' ? 'Tenant suspended' : 'Tenant reactivated');
      setStatusDialog(null);
    },
  });
  const saveEntitlements = useMutation({
    mutationFn: () =>
      apiRequest(`/v1/platform/tenants/${id}/entitlements`, {
        method: 'PUT',
        body: {
          reason,
          overrides: Object.fromEntries(
            Object.entries(overrides).map(([k, v]) => [k, v === 'default' ? null : v === 'on']),
          ),
        },
      }),
    onSuccess: () => {
      void tenant.refetch();
      setReason('');
      toast('Entitlements updated');
    },
  });

  if (!me.can('platform.tenants.read')) return <ForbiddenState />;
  if (tenant.error) return <ErrorState error={tenant.error} onRetry={() => void tenant.refetch()} />;
  if (tenant.isLoading || !tenant.data) return <LoadingState />;
  const t = tenant.data;
  const manage = me.can('platform.tenants.manage');
  const entitlementsDirty = t.entitlements.some(
    (f) => (f.override === null ? 'default' : f.override ? 'on' : 'off') !== overrides[f.key],
  );

  return (
    <>
      <PageHeader
        title={t.displayName}
        description={
          <>
            <Link href="/tenants">Tenants</Link> · <span className="uc-mono">{t.slug}</span> ·{' '}
            {PRESETS[t.preset].label}
          </>
        }
        actions={
          <>
            {t.isDemo && <Badge tone="warning">Demo</Badge>}
            <StatusBadge status={t.status} />
            {manage && t.status === 'active' && (
              <Button variant="danger" onClick={() => setStatusDialog('suspend')}>
                Suspend
              </Button>
            )}
            {manage && t.status === 'suspended' && (
              <Button variant="primary" onClick={() => setStatusDialog('reactivate')}>
                Reactivate
              </Button>
            )}
          </>
        }
      />
      {t.status === 'suspended' && (
        <Alert tone="warning" title="Suspended">
          {t.suspendedReason ?? 'No reason recorded'} — merchant staff cannot access this tenant and its
          storefronts do not resolve.
        </Alert>
      )}
      <section className="uc-grid" aria-label="Tenant counts">
        {Object.entries(t.counts).map(([k, v]) => (
          <div key={k} className="uc-card uc-stat">
            <span className="uc-muted">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
            <strong>{v}</strong>
          </div>
        ))}
      </section>
      <Card title="Profile">
        <div className="uc-form-grid">
          <TextField label="Legal name" value={t.legalName} disabled />
          <TextField label="Contact email" value={t.contactEmail ?? ''} disabled />
          <TextField label="Country / currency" value={`${t.countryCode} / ${t.defaultCurrency}`} disabled />
          <TextField label="Time zone / locale" value={`${t.timezone} / ${t.defaultLocale}`} disabled />
        </div>
        <span className="uc-muted">
          Created {formatDateTime(t.createdAt)} · version {t.version}
        </span>
      </Card>
      <Card title="Feature entitlements">
        <p className="uc-muted" style={{ margin: 0 }}>
          Effective = preset default unless overridden. Changes are audited and require a reason.
        </p>
        <DataTable
          caption="Feature entitlements"
          rows={t.entitlements}
          rowKey={(f) => f.key}
          empty={null}
          columns={[
            {
              key: 'feature',
              header: 'Feature',
              render: (f) => (
                <>
                  {f.label}
                  <br />
                  <span className="uc-muted">{f.description}</span>
                </>
              ),
            },
            { key: 'default', header: 'Preset default', render: (f) => (f.presetDefault ? 'On' : 'Off') },
            {
              key: 'override',
              header: 'Override',
              render: (f) =>
                me.can('platform.entitlements.manage') ? (
                  <SelectField
                    label={`Override for ${f.label}`}
                    hideLabel
                    value={overrides[f.key] ?? 'default'}
                    onChange={(e) =>
                      setOverrides((o) => ({ ...o, [f.key as FeatureKey]: e.target.value as Override }))
                    }
                    options={[
                      { value: 'default', label: 'Follow preset' },
                      { value: 'on', label: 'Force on' },
                      { value: 'off', label: 'Force off' },
                    ]}
                  />
                ) : f.override === null ? (
                  'Follow preset'
                ) : f.override ? (
                  'Forced on'
                ) : (
                  'Forced off'
                ),
            },
            {
              key: 'effective',
              header: 'Effective',
              render: (f) => (
                <Badge tone={f.effective ? 'success' : undefined}>
                  {f.effective ? 'Enabled' : 'Disabled'}
                </Badge>
              ),
            },
          ]}
        />
        {me.can('platform.entitlements.manage') && (
          <div className="uc-row" style={{ alignItems: 'flex-end' }}>
            <TextField
              label="Reason for change"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              hint="Recorded in the audit log (min 5 characters)"
            />
            <Button
              variant="primary"
              disabled={!entitlementsDirty || reason.trim().length < 5}
              loading={saveEntitlements.isPending}
              onClick={() => saveEntitlements.mutate()}
            >
              Save entitlements
            </Button>
          </div>
        )}
        {saveEntitlements.error && <Alert tone="danger">{errorMessage(saveEntitlements.error)}</Alert>}
      </Card>
      <ConfirmDialog
        open={statusDialog !== null}
        title={statusDialog === 'suspend' ? `Suspend ${t.displayName}?` : `Reactivate ${t.displayName}?`}
        description={
          statusDialog === 'suspend'
            ? 'All merchant staff lose access immediately and storefront domains stop resolving. Data is retained.'
            : 'Merchant staff regain access and storefronts resolve again.'
        }
        confirmLabel={statusDialog === 'suspend' ? 'Suspend tenant' : 'Reactivate tenant'}
        tone={statusDialog === 'suspend' ? 'danger' : 'primary'}
        requireReason
        loading={changeStatus.isPending}
        error={changeStatus.error ? errorMessage(changeStatus.error) : null}
        onConfirm={(why) => statusDialog && changeStatus.mutate({ action: statusDialog, why })}
        onClose={() => setStatusDialog(null)}
      />
    </>
  );
}
