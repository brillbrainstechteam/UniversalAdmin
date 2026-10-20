'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SupportGrant, SupportGrantStatus } from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ForbiddenState,
  PageHeader,
  errorMessage,
  formatDateTime,
} from '@uc/ui';
import { useState } from 'react';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

const TONE: Record<SupportGrantStatus, 'success' | 'warning' | 'danger' | 'info' | undefined> = {
  requested: 'warning',
  approved: 'success',
  denied: undefined,
  revoked: 'danger',
  expired: undefined,
};

type Action = { kind: 'approve' | 'deny' | 'revoke'; grant: SupportGrant };

export default function SupportAccessPage() {
  const { api, can, tenantId, context } = useTenant();
  const qc = useQueryClient();
  const tz = context.tenant.timezone;
  const enabled = can('support.manage');
  const list = useTenantQuery<{ items: SupportGrant[] }>(
    ['support-grants'],
    '/v1/admin/support-grants',
    undefined,
    enabled,
  );
  const [action, setAction] = useState<Action | null>(null);
  const act = useMutation({
    mutationFn: ({ kind, grant, note }: Action & { note?: string }) =>
      api(`/v1/admin/support-grants/${grant.id}/${kind}`, {
        method: 'POST',
        body: kind === 'revoke' ? undefined : { version: grant.version, note: note || undefined },
      }),
    onSuccess: () => {
      setAction(null);
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'support-grants'] });
    },
  });
  if (!enabled) return <ForbiddenState message="Only owners can approve platform support access." />;

  const copy: Record<Action['kind'], { title: string; label: string; tone: 'danger' | 'primary' }> = {
    approve: { title: 'Approve support access', label: 'Approve', tone: 'primary' },
    deny: { title: 'Deny support access', label: 'Deny', tone: 'danger' },
    revoke: { title: 'End support access now', label: 'End access', tone: 'danger' },
  };

  return (
    <>
      <PageHeader
        title="Support access"
        description="Platform support can see your admin only when an owner approves a request, only for the time approved, and read-only. Every page they open is recorded in the audit log."
      />
      <Card>
        <DataTable
          caption="Support access requests"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          rowKey={(g) => g.id}
          empty={
            <EmptyState
              title="No support requests"
              description="Requests from platform support appear here."
            />
          }
          columns={[
            {
              key: 'who',
              header: 'Requested by',
              render: (g) => (
                <>
                  <strong>{g.requestedBy.displayName}</strong>
                  <div className="uc-muted">{g.requestedBy.email}</div>
                  <div className="uc-muted">{formatDateTime(g.createdAt, tz)}</div>
                </>
              ),
            },
            {
              key: 'why',
              header: 'Reason',
              render: (g) => (
                <>
                  {g.reason}
                  {g.ticketRef && <div className="uc-muted">Ticket {g.ticketRef}</div>}
                </>
              ),
            },
            { key: 'len', header: 'Duration', render: (g) => `${g.durationMinutes} min` },
            {
              key: 'st',
              header: 'Status',
              render: (g) => (
                <>
                  <Badge tone={TONE[g.status]}>{g.status}</Badge>
                  {g.status === 'approved' && g.expiresAt && (
                    <div className="uc-muted">until {formatDateTime(g.expiresAt, tz)}</div>
                  )}
                  {g.decidedBy && <div className="uc-muted">by {g.decidedBy}</div>}
                </>
              ),
            },
            { key: 'n', header: 'Pages viewed', render: (g) => g.requestCount },
            {
              key: 'a',
              header: 'Actions',
              render: (g) => (
                <div className="uc-row">
                  {g.status === 'requested' && (
                    <>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => setAction({ kind: 'approve', grant: g })}
                      >
                        Approve
                      </Button>
                      <Button size="sm" onClick={() => setAction({ kind: 'deny', grant: g })}>
                        Deny
                      </Button>
                    </>
                  )}
                  {(g.status === 'approved' || g.status === 'requested') && (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => setAction({ kind: 'revoke', grant: g })}
                    >
                      {g.status === 'approved' ? 'End access' : 'Withdraw'}
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
        />
      </Card>
      {act.error && !action && <Alert tone="danger">{errorMessage(act.error)}</Alert>}
      {action && (
        <ConfirmDialog
          open
          title={copy[action.kind].title}
          tone={copy[action.kind].tone}
          confirmLabel={copy[action.kind].label}
          description={
            action.kind === 'approve'
              ? `${action.grant.requestedBy.displayName} will be able to view (not change) this admin for ${action.grant.durationMinutes} minutes, without customer personal data or the audit log.`
              : action.kind === 'deny'
                ? 'The operator will not get access. You can add a note.'
                : 'The operator is signed out of this merchant immediately.'
          }
          loading={act.isPending}
          error={act.error ? errorMessage(act.error) : undefined}
          onClose={() => setAction(null)}
          onConfirm={(note) => act.mutate({ ...action, note })}
        />
      )}
    </>
  );
}
