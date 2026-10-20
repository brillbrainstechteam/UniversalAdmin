'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Plan, PlanUsage, SupportGrant, SupportSessionStarted } from '@uc/contracts';
import {
  Alert,
  apiRequest,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  LoadingState,
  SelectField,
  TextField,
  UsageTable,
  errorMessage,
  formatDateTime,
} from '@uc/ui';
import { useState } from 'react';
import { usePlatformMe, usePlatformQuery } from './platform';

/** Phase 12: tenant plan, live usage and plan assignment (audited, reason required). */
export function TenantPlanCard({ tenantId, timeZone }: { tenantId: string; timeZone: string }) {
  const me = usePlatformMe();
  const qc = useQueryClient();
  const usage = usePlatformQuery<PlanUsage>(['usage', tenantId], `/v1/platform/tenants/${tenantId}/usage`);
  const plans = usePlatformQuery<{ items: Plan[] }>(['plans'], '/v1/platform/plans');
  const [form, setForm] = useState<{ planKey: string; reason: string } | null>(null);
  const assign = useMutation({
    mutationFn: () =>
      apiRequest<PlanUsage>(`/v1/platform/tenants/${tenantId}/plan`, { method: 'PUT', body: form! }),
    onSuccess: (data) => {
      setForm(null);
      qc.setQueryData(['p', 'usage', tenantId, {}], data);
      void qc.invalidateQueries({ queryKey: ['p', 'plans'] });
    },
  });
  return (
    <Card
      title={usage.data ? `Plan: ${usage.data.plan.name}` : 'Plan'}
      actions={
        me.can('platform.plans.manage') &&
        usage.data && (
          <Button size="sm" onClick={() => setForm({ planKey: usage.data!.plan.key, reason: '' })}>
            Change plan
          </Button>
        )
      }
    >
      {usage.isLoading ? (
        <LoadingState rows={3} />
      ) : usage.error || !usage.data ? (
        <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />
      ) : (
        <UsageTable usage={usage.data} timeZone={timeZone} />
      )}
      <Dialog
        open={form !== null}
        title="Change plan"
        onClose={() => setForm(null)}
        footer={
          <>
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!form || form.reason.trim().length < 3}
              loading={assign.isPending}
              onClick={() => assign.mutate()}
            >
              Change plan
            </Button>
          </>
        }
      >
        {form && (
          <>
            {assign.error && <Alert tone="danger">{errorMessage(assign.error)}</Alert>}
            <SelectField
              label="Plan"
              value={form.planKey}
              onChange={(e) => setForm({ ...form, planKey: e.target.value })}
              options={(plans.data?.items ?? [])
                .filter((p) => p.status === 'active')
                .map((p) => ({ value: p.key, label: p.name }))}
            />
            <TextField
              label="Reason"
              hint="Recorded in the audit log of the platform and of the merchant."
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
            <p className="uc-muted">
              A lower plan never deletes anything: records over a limit stay, but new ones are refused until
              usage is back under it.
            </p>
          </>
        )}
      </Dialog>
    </Card>
  );
}

const TONE = {
  requested: 'warning',
  approved: 'success',
  denied: undefined,
  revoked: 'danger',
  expired: undefined,
} as const;

/** Phase 12: just-in-time support access — request, start (requester only, after merchant approval), end. */
export function SupportAccessCard({ tenantId, active }: { tenantId: string; active: boolean }) {
  const me = usePlatformMe();
  const qc = useQueryClient();
  const allowed = me.can('platform.support.request');
  const grants = usePlatformQuery<{ items: SupportGrant[] }>(
    ['support-grants', tenantId],
    '/v1/platform/support-grants',
    { tenantId },
    allowed,
  );
  const [form, setForm] = useState<{ reason: string; ticketRef: string; durationMinutes: string } | null>(
    null,
  );
  const refresh = () => void qc.invalidateQueries({ queryKey: ['p', 'support-grants', tenantId] });
  const ask = useMutation({
    mutationFn: () =>
      apiRequest<SupportGrant>(`/v1/platform/tenants/${tenantId}/support-grants`, {
        method: 'POST',
        body: {
          reason: form!.reason.trim(),
          ticketRef: form!.ticketRef.trim() || undefined,
          durationMinutes: Number.parseInt(form!.durationMinutes, 10),
        },
      }),
    onSuccess: () => {
      setForm(null);
      refresh();
    },
  });
  const start = useMutation({
    mutationFn: (id: string) =>
      apiRequest<SupportSessionStarted>(`/v1/platform/support-grants/${id}/start`, { method: 'POST' }),
    onSuccess: (r) => {
      refresh();
      window.open(r.merchantAdminUrl, '_blank', 'noopener');
    },
  });
  const end = useMutation({
    mutationFn: (id: string) => apiRequest(`/v1/platform/support-grants/${id}/revoke`, { method: 'POST' }),
    onSuccess: refresh,
  });
  if (!allowed) return null;
  const myId = me.data?.user.id;
  return (
    <Card
      title="Support access"
      actions={
        active && (
          <Button size="sm" onClick={() => setForm({ reason: '', ticketRef: '', durationMinutes: '60' })}>
            Request access
          </Button>
        )
      }
    >
      <p className="uc-muted" style={{ marginTop: 0 }}>
        Read-only access to this merchant&apos;s admin, only after one of its owners approves, only for the
        approved time. Every page you open is recorded in the merchant&apos;s audit log.
      </p>
      {(start.error || end.error) && <Alert tone="danger">{errorMessage(start.error ?? end.error)}</Alert>}
      <DataTable
        caption="Support access requests"
        rows={grants.data?.items}
        isLoading={grants.isLoading}
        error={grants.error}
        rowKey={(g) => g.id}
        empty={<EmptyState title="No support requests for this merchant" />}
        columns={[
          {
            key: 'who',
            header: 'Operator',
            render: (g) => (
              <>
                {g.requestedBy.displayName}
                <div className="uc-muted">{formatDateTime(g.createdAt)}</div>
              </>
            ),
          },
          { key: 'why', header: 'Reason', render: (g) => g.reason },
          {
            key: 'st',
            header: 'Status',
            render: (g) => (
              <>
                <Badge tone={TONE[g.status]}>{g.status}</Badge>
                {g.status === 'approved' && g.expiresAt && (
                  <div className="uc-muted">until {formatDateTime(g.expiresAt)}</div>
                )}
              </>
            ),
          },
          { key: 'n', header: 'Pages viewed', render: (g) => g.requestCount },
          {
            key: 'a',
            header: 'Actions',
            render: (g) =>
              g.requestedBy.id === myId && (
                <div className="uc-row">
                  {g.status === 'approved' && (
                    <Button
                      size="sm"
                      variant="primary"
                      loading={start.isPending}
                      onClick={() => start.mutate(g.id)}
                    >
                      Open merchant admin
                    </Button>
                  )}
                  {(g.status === 'approved' || g.status === 'requested') && (
                    <Button size="sm" variant="danger" onClick={() => end.mutate(g.id)}>
                      {g.status === 'approved' ? 'End access' : 'Withdraw'}
                    </Button>
                  )}
                </div>
              ),
          },
        ]}
      />
      <Dialog
        open={form !== null}
        title="Request support access"
        onClose={() => setForm(null)}
        footer={
          <>
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!form || form.reason.trim().length < 10}
              loading={ask.isPending}
              onClick={() => ask.mutate()}
            >
              Send request
            </Button>
          </>
        }
      >
        {form && (
          <>
            {ask.error && <Alert tone="danger">{errorMessage(ask.error)}</Alert>}
            <TextField
              label="Reason"
              hint="Shown to the merchant's owners. At least 10 characters."
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
            <TextField
              label="Ticket reference (optional)"
              value={form.ticketRef}
              onChange={(e) => setForm({ ...form, ticketRef: e.target.value })}
            />
            <SelectField
              label="Duration"
              value={form.durationMinutes}
              onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })}
              options={['15', '30', '60', '120'].map((m) => ({ value: m, label: `${m} minutes` }))}
            />
          </>
        )}
      </Dialog>
    </Card>
  );
}
