'use client';

import type { Page, SyncJob, SyncJobRow } from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  SelectField,
  StatusBadge,
  errorMessage,
  formatDateTime,
  useCursorPagination,
} from '@uc/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { qtyText, useInventoryAction } from '../../../../../../lib/inventory';
import { useTenant, useTenantQuery } from '../../../../../../lib/tenant';

const ACTION_TONE: Record<string, 'success' | 'info' | 'warning' | 'danger' | undefined> = {
  create: 'success',
  update: 'info',
  unchanged: undefined,
  stale: 'warning',
  delete: 'warning',
  error: 'danger',
};
const ACTION_LABEL: Record<string, string> = {
  create: 'new',
  update: 'changed',
  unchanged: 'same',
  stale: 'older version (skipped)',
  delete: 'deleted in source (flag)',
  error: 'error',
};

export default function SyncJobPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const { can, tenantId, context, api } = useTenant();
  const enabled = can('integrations.read') && context.features.includes('integrations');
  const tz = context.tenant.timezone;
  const job = useTenantQuery<SyncJob>(
    ['integrations', 'job', jobId],
    `/v1/admin/integrations/jobs/${jobId}`,
    undefined,
    enabled,
  );
  const [action, setAction] = useState('');
  const pager = useCursorPagination(action);
  const rows = useTenantQuery<Page<SyncJobRow>>(
    ['integrations', 'job-rows', jobId],
    `/v1/admin/integrations/jobs/${jobId}/rows`,
    { action, cursor: pager.cursor, limit: 50 },
    enabled,
  );
  const [confirm, setConfirm] = useState<'atomic' | 'partial' | 'discard' | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const commit = useInventoryAction(
    (mode: 'atomic' | 'partial') =>
      api<SyncJob>(`/v1/admin/integrations/jobs/${jobId}/commit`, { method: 'POST', body: { mode } }),
    (j) =>
      `Applied ${j.counts.applied} row(s)${j.stockResult ? ` · ${j.stockResult.movements} stock movement(s)` : ''}`,
    () => setConfirm(null),
  );
  const discard = useInventoryAction(
    () => api<SyncJob>(`/v1/admin/integrations/jobs/${jobId}/discard`, { method: 'POST' }),
    'Preview discarded',
    () => setConfirm(null),
  );

  const downloadErrors = async () => {
    setDownloadError(null);
    try {
      const res = await fetch(`/api/v1/admin/integrations/jobs/${jobId}/errors.csv`, {
        headers: { 'X-Tenant-Id': tenantId },
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `sync-errors-${jobId.slice(0, 8)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setDownloadError(errorMessage(e));
    }
  };

  if (!enabled) return <ForbiddenState />;
  if (job.isLoading) return <LoadingState />;
  if (job.error) return <ErrorState error={job.error} onRetry={() => void job.refetch()} />;
  const j = job.data!;
  const canManage = can('integrations.manage');
  const previewed = j.status === 'previewed';
  const changes = j.counts.create + j.counts.update + j.counts.delete;

  return (
    <>
      <PageHeader
        title={j.fileName ? `Import ${j.fileName}` : `Simulator pull (step ${j.cursorTo})`}
        description={
          <>
            <Link href={`/t/${tenantId}/integrations/connections/${j.connectionId}`}>{j.connectionName}</Link>{' '}
            · <StatusBadge status={j.status} /> · mapping v{j.mappingVersion} · source as of{' '}
            {formatDateTime(j.snapshotAsOf, tz)}
          </>
        }
        actions={
          previewed &&
          canManage && (
            <>
              <Button
                variant="primary"
                disabled={j.counts.error > 0 || changes === 0}
                onClick={() => setConfirm('atomic')}
              >
                Apply all
              </Button>
              {j.counts.error > 0 && (
                <Button onClick={() => setConfirm('partial')}>Apply valid rows only</Button>
              )}
              <Button variant="ghost" onClick={() => setConfirm('discard')}>
                Discard
              </Button>
            </>
          )
        }
      />
      {previewed && (
        <Alert tone="info">
          This is a preview: nothing has changed yet.{' '}
          {changes === 0 ? 'There are no changes to apply.' : 'Review the rows, then apply.'}
        </Alert>
      )}
      <section className="uc-grid" aria-label="Row summary">
        {(
          [
            ['Rows', j.counts.total],
            ['New', j.counts.create],
            ['Changed', j.counts.update],
            ['Same as before', j.counts.unchanged],
            ['Older version (skipped)', j.counts.stale],
            ['Deleted in source', j.counts.delete],
            ['Errors', j.counts.error],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="uc-card uc-stat">
            <span className="uc-muted">{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </section>
      {j.stockResult && (
        <Card title="Stock applied">
          <p style={{ margin: 0 }}>
            {j.stockResult.locations} location(s) · {j.stockResult.movements} ledger movement(s) ·{' '}
            {j.stockResult.stale} stale snapshot(s) · {j.stockResult.issues} discrepancy(ies) raised.{' '}
            <Link
              href={`/t/${tenantId}/inventory/movements?reference=${encodeURIComponent(`ERP:${j.id}:pieces`)}`}
            >
              Piece receipts
            </Link>
          </p>
        </Card>
      )}
      <Card
        title="Rows"
        actions={
          j.counts.error > 0 && (
            <Button size="sm" onClick={() => void downloadErrors()}>
              Download error rows (CSV)
            </Button>
          )
        }
      >
        {downloadError && <Alert tone="danger">{downloadError}</Alert>}
        <div className="uc-filters">
          <SelectField
            label="Show"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            options={[
              { value: '', label: 'All rows' },
              ...Object.entries(ACTION_LABEL).map(([value, label]) => ({ value, label })),
            ]}
          />
        </div>
        <DataTable
          caption="Staged rows"
          rows={rows.data?.items}
          isLoading={rows.isLoading}
          error={rows.error}
          onRetry={() => void rows.refetch()}
          rowKey={(r) => String(r.rowNo)}
          pagination={pager.controls(rows.data?.nextCursor)}
          empty={<EmptyState title="No rows" description="Nothing matches this filter." />}
          columns={[
            { key: 'row', header: 'Row', render: (r) => r.rowNo },
            {
              key: 'ext',
              header: 'External ID',
              render: (r) => <span className="uc-mono">{r.externalId ?? '—'}</span>,
            },
            {
              key: 'action',
              header: 'Outcome',
              render: (r) => (
                <span className="uc-row">
                  <Badge tone={ACTION_TONE[r.action]}>{ACTION_LABEL[r.action]}</Badge>
                  {r.applied && <Badge tone="success">applied</Badge>}
                </span>
              ),
            },
            {
              key: 'what',
              header: 'Record',
              render: (r) =>
                r.record ? (
                  <span>
                    {r.record.recordType === 'piece' ? `Piece ${r.record.tag}` : r.record.sku} ·{' '}
                    {r.record.title ?? ''}
                    {r.record.quantity !== null
                      ? ` · ${qtyText(r.record.quantity, r.record.unit)} at ${r.record.location}`
                      : ''}
                    {r.record.grossG ? ` · ${r.record.grossG} g gross` : ''}
                  </span>
                ) : (
                  <span className="uc-muted">{Object.values(r.raw).slice(0, 4).join(' · ')}</span>
                ),
            },
            {
              key: 'errors',
              header: 'Problems',
              render: (r) =>
                r.errors.length ? (
                  <ul className="uc-error" style={{ margin: 0, paddingLeft: 16 }}>
                    {r.errors.map((e) => (
                      <li key={e.field + e.message}>
                        {e.field}: {e.message}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="uc-muted">—</span>
                ),
            },
          ]}
        />
      </Card>
      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm === 'discard'
            ? 'Discard this preview'
            : confirm === 'partial'
              ? 'Apply valid rows only'
              : 'Apply all rows'
        }
        description={
          confirm === 'discard'
            ? 'Nothing will be imported from this preview.'
            : confirm === 'partial'
              ? `${changes} valid change(s) will be applied; ${j.counts.error} row(s) with errors are skipped and stay listed here.`
              : `${changes} change(s) will be applied in one step. Stock follows the field ownership set on the connection.`
        }
        confirmLabel={confirm === 'discard' ? 'Discard' : 'Apply'}
        tone={confirm === 'discard' ? 'danger' : 'primary'}
        loading={commit.isPending || discard.isPending}
        error={commit.error ? errorMessage(commit.error) : discard.error ? errorMessage(discard.error) : null}
        onConfirm={() => (confirm === 'discard' ? discard.mutate(undefined) : commit.mutate(confirm!))}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}
