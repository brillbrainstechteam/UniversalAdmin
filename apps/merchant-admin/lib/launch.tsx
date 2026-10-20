'use client';

import type { PilotChecklist, SetupChecklist, SupportSessionInfo } from '@uc/contracts';
import { Badge, Card, ErrorState, LoadingState, formatDateTime } from '@uc/ui';
import Link from 'next/link';
import { useTenant, useTenantQuery } from './tenant';

/** Phase 12 setup checklist (computed from real records). `compact` shows open steps only (Home card). */
export function SetupChecklistCard({ compact = false }: { compact?: boolean }) {
  const { tenantId } = useTenant();
  const q = useTenantQuery<SetupChecklist>(['setup'], '/v1/admin/setup');
  if (q.isLoading) return <LoadingState label="Loading setup checklist" rows={3} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const c = q.data;
  const steps = compact ? c.steps.filter((s) => !s.done) : c.steps;
  return (
    <Card
      title="Setup checklist"
      actions={compact ? <Link href={`/t/${tenantId}/setup`}>Open setup guide</Link> : undefined}
    >
      <p className="uc-muted" style={{ marginTop: 0 }}>
        {c.requiredDone} of {c.requiredTotal} required steps done.
      </p>
      <progress
        value={c.requiredDone}
        max={c.requiredTotal}
        aria-label={`Setup progress: ${c.requiredDone} of ${c.requiredTotal} required steps done`}
        style={{ width: '100%' }}
      />
      {steps.length === 0 ? (
        <p>Everything is set up.</p>
      ) : (
        <ul className="uc-stack" style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
          {steps.map((s) => (
            <li key={s.key} className="uc-row" style={{ alignItems: 'flex-start' }}>
              <Badge tone={s.done ? 'success' : s.optional ? 'info' : 'warning'}>
                {s.done ? 'Done' : s.optional ? 'Optional' : 'To do'}
              </Badge>
              <span>
                {s.done ? (
                  <strong>{s.title}</strong>
                ) : (
                  <Link href={`/t/${tenantId}${s.link}`}>{s.title}</Link>
                )}
                {!compact && <div className="uc-muted">{s.detail}</div>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const PILOT_TONE = {
  done: 'success',
  todo: 'warning',
  blocked: 'danger',
  not_applicable: undefined,
} as const;

export function PilotChecklistCard({ connectionId }: { connectionId: string }) {
  const q = useTenantQuery<PilotChecklist>(
    ['pilot', connectionId],
    `/v1/admin/integrations/connections/${connectionId}/pilot-checklist`,
  );
  if (q.isLoading) return <LoadingState label="Loading pilot checklist" rows={3} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <Card title="Pilot readiness">
      <p className="uc-muted" style={{ marginTop: 0 }}>
        Each step is read from this connection&apos;s real sync history. A connector is called
        production-supported only after acceptance with the vendor.
      </p>
      <ol className="uc-stack" style={{ margin: 0, paddingLeft: 18 }}>
        {q.data.steps.map((s) => (
          <li key={s.key}>
            <span className="uc-row">
              <Badge tone={PILOT_TONE[s.state]}>{s.state.replace('_', ' ')}</Badge>
              <strong>{s.title}</strong>
            </span>
            <div className="uc-muted">{s.detail}</div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function SupportBanner({ support, timeZone }: { support: SupportSessionInfo; timeZone: string }) {
  return (
    <div className="uc-support-banner" role="status">
      <strong>Platform support session (read-only)</strong> — ends{' '}
      {formatDateTime(support.expiresAt, timeZone)}. Reason: {support.reason}. Every page viewed is recorded
      in this merchant&apos;s audit log.
    </div>
  );
}
