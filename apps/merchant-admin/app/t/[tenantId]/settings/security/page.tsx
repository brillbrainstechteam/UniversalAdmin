'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Card, Checkbox, PageHeader, errorMessage, useToast } from '@uc/ui';
import Link from 'next/link';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

export default function SecuritySettingsPage() {
  const { api, can, tenantId } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const setting = useTenantQuery<{ requireMfaForAdmins: boolean }>(
    ['security'],
    '/v1/admin/security',
    undefined,
    can('settings.read'),
  );
  const save = useMutation({
    mutationFn: (v: boolean) =>
      api('/v1/admin/security', { method: 'PUT', body: { requireMfaForAdmins: v } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'security'] });
      toast('Security setting saved');
    },
  });
  return (
    <>
      <PageHeader title="Security" description="Two-step verification for this merchant's staff." />
      <Card title="Your account">
        <p>
          Your own two-step verification is managed in <Link href="/account/security">Account security</Link>.
        </p>
      </Card>
      {can('settings.read') && setting.data && (
        <Card title="Merchant policy">
          <Checkbox
            label="Require two-step verification for owners and administrators"
            description="Owners and admins without it are blocked from this merchant until they turn it on"
            checked={setting.data.requireMfaForAdmins}
            disabled={!can('settings.manage') || save.isPending}
            onChange={(e) => save.mutate(e.target.checked)}
          />
          {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
        </Card>
      )}
    </>
  );
}
