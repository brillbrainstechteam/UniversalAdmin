'use client';

import {
  MAPPING_TARGETS,
  MAPPING_TARGET_KEYS,
  type Connection,
  type FieldMapping,
  type MappingPreviewResponse,
  type MappingRule,
  type OutboundCommand,
  type Page,
  type ReconciliationIssue,
  type SimulatorState,
  type SyncJob,
} from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  SelectField,
  StatusBadge,
  TextField,
  errorMessage,
  formatDateTime,
  useCursorPagination,
} from '@uc/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { serverErrors } from '../../../../../../lib/forms';
import { useInventoryAction } from '../../../../../../lib/inventory';
import { useTenant, useTenantQuery } from '../../../../../../lib/tenant';

type Section = 'overview' | 'sync' | 'mapping' | 'records' | 'outbound' | 'discrepancies';
const SECTIONS: { key: Section; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'sync', label: 'Sync' },
  { key: 'mapping', label: 'Field mapping' },
  { key: 'records', label: 'Linked records' },
  { key: 'discrepancies', label: 'Discrepancies' },
  { key: 'outbound', label: 'Order export' },
];

const OWNED: { key: keyof Connection['ownership']; label: string }[] = [
  { key: 'title', label: 'Product titles' },
  { key: 'sku', label: 'SKUs' },
  { key: 'weights', label: 'Piece weights & HUID' },
  { key: 'stock', label: 'Stock quantities' },
  { key: 'pieces', label: 'Piece receipts' },
];

/** Small RFC-4180 parser for pasted sample rows (preview only). */
function parseSample(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"' && field === '') q = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  const [header, ...data] = rows;
  if (!header) return [];
  return data
    .slice(0, 20)
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ConnectionPage() {
  const { connectionId } = useParams<{ connectionId: string }>();
  const { can, tenantId, context, api } = useTenant();
  const router = useRouter();
  const enabled = can('integrations.read') && context.features.includes('integrations');
  const canManage = can('integrations.manage');
  const tz = context.tenant.timezone;
  const [section, setSection] = useState<Section>('overview');
  const conn = useTenantQuery<Connection>(
    ['integrations', 'connection', connectionId],
    `/v1/admin/integrations/connections/${connectionId}`,
    undefined,
    enabled,
  );
  const isSim = conn.data?.connectorKey === 'simulator';
  const mappings = useTenantQuery<{ items: FieldMapping[] }>(
    ['integrations', 'mappings', connectionId],
    `/v1/admin/integrations/connections/${connectionId}/mappings`,
    undefined,
    enabled,
  );
  const jobsPager = useCursorPagination(connectionId);
  const jobs = useTenantQuery<Page<SyncJob>>(
    ['integrations', 'jobs', connectionId],
    '/v1/admin/integrations/jobs',
    { connectionId, cursor: jobsPager.cursor, limit: 10 },
    enabled,
  );
  const sim = useTenantQuery<SimulatorState>(
    ['integrations', 'simulator', connectionId],
    `/v1/admin/integrations/connections/${connectionId}/simulator`,
    undefined,
    enabled && isSim,
  );
  const [recQ, setRecQ] = useState('');
  const recPager = useCursorPagination(recQ);
  const records = useTenantQuery<
    Page<{
      id: string;
      recordType: string;
      externalId: string;
      label: string;
      externalVersion: string | null;
      deletedAt: string | null;
      updatedAt: string;
    }>
  >(
    ['integrations', 'records', connectionId],
    `/v1/admin/integrations/connections/${connectionId}/records`,
    { q: recQ, cursor: recPager.cursor, limit: 25 },
    enabled && section === 'records',
  );
  const outPager = useCursorPagination(connectionId);
  const outbound = useTenantQuery<Page<OutboundCommand>>(
    ['integrations', 'outbound', connectionId],
    '/v1/admin/integrations/outbound',
    { connectionId, cursor: outPager.cursor, limit: 25 },
    enabled && section === 'outbound',
  );
  const [issueStatus, setIssueStatus] = useState<'open' | 'resolved'>('open');
  const issues = useTenantQuery<{ items: ReconciliationIssue[] }>(
    ['integrations', 'discrepancies', connectionId],
    `/v1/admin/integrations/connections/${connectionId}/discrepancies`,
    { status: issueStatus },
    enabled && section === 'discrepancies',
  );

  // ---- forms
  const [ownership, setOwnership] = useState<Connection['ownership'] | null>(null);
  const [settings, setSettings] = useState<Connection['settings'] | null>(null);
  const [reason, setReason] = useState('');
  const [statusChange, setStatusChange] = useState<'active' | 'paused' | 'disconnected' | null>(null);
  const [rules, setRules] = useState<MappingRule[]>([]);
  const [sample, setSample] = useState('');
  const [preview, setPreview] = useState<MappingPreviewResponse | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [orderRef, setOrderRef] = useState('');
  const [orderSku, setOrderSku] = useState('SIM-RING-01');
  const [orderQty, setOrderQty] = useState('1');
  const [failNext, setFailNext] = useState('0');
  const [timeoutNext, setTimeoutNext] = useState('0');
  const [resolving, setResolving] = useState<{
    issue: ReconciliationIssue;
    decision: 'accept_erp' | 'keep_commerce';
  } | null>(null);

  useEffect(() => {
    if (conn.data) {
      setOwnership(conn.data.ownership);
      setSettings(conn.data.settings);
    }
  }, [conn.data]);
  const active = mappings.data?.items.find((m) => m.active);
  useEffect(() => {
    if (active) setRules(active.rules);
  }, [active]);
  useEffect(() => setOrderRef(`TEST-SO-${Date.now().toString(36).toUpperCase()}`), []);

  const fail = (e: unknown) => setFormError(serverErrors(e).message ?? errorMessage(e));
  const saveConnection = useInventoryAction(
    (body: Record<string, unknown>) =>
      api<Connection>(`/v1/admin/integrations/connections/${connectionId}`, {
        method: 'PATCH',
        body: { version: conn.data!.version, ...body },
      }),
    'Connection saved',
    () => {
      setReason('');
      setStatusChange(null);
      setFormError(null);
    },
  );
  const publishMapping = useInventoryAction(
    () =>
      api<FieldMapping>(`/v1/admin/integrations/connections/${connectionId}/mappings`, {
        method: 'POST',
        body: { rules },
      }),
    (m) => `Mapping version ${m.version} published`,
  );
  const runPreview = useInventoryAction(
    () =>
      api<MappingPreviewResponse>('/v1/admin/integrations/mappings/preview', {
        method: 'POST',
        body: { rules, rows: parseSample(sample) },
      }),
    'Preview ready (nothing was saved)',
    (r) => setPreview(r),
  );
  const pull = useInventoryAction(
    () => api<SyncJob>(`/v1/admin/integrations/connections/${connectionId}/jobs/pull`, { method: 'POST' }),
    'Pulled from the simulator: review the preview',
    (j) => router.push(`/t/${tenantId}/integrations/jobs/${j.id}`),
  );
  const uploadFile = useInventoryAction(
    async (file: File) =>
      api<SyncJob>(`/v1/admin/integrations/connections/${connectionId}/jobs/file`, {
        method: 'POST',
        body: { fileName: file.name, contentBase64: await readBase64(file) },
      }),
    'File staged: review the preview',
    (j) => router.push(`/t/${tenantId}/integrations/jobs/${j.id}`),
  );
  const advance = useInventoryAction(
    () =>
      api<SimulatorState>(`/v1/admin/integrations/connections/${connectionId}/simulator/advance`, {
        method: 'POST',
      }),
    (s) => `Simulator at step ${s.tick}`,
  );
  const failures = useInventoryAction(
    () =>
      api<SimulatorState>(`/v1/admin/integrations/connections/${connectionId}/simulator/failures`, {
        method: 'POST',
        body: {
          failNext: Number.parseInt(failNext || '0', 10),
          timeoutNext: Number.parseInt(timeoutNext || '0', 10),
        },
      }),
    'Simulated outages set',
  );
  const testOrder = useInventoryAction(
    () =>
      api<OutboundCommand>(`/v1/admin/integrations/connections/${connectionId}/outbound/test-order`, {
        method: 'POST',
        body: { reference: orderRef, lines: [{ sku: orderSku, quantity: orderQty }] },
      }),
    (c) => `Order ${c.reference} queued for export (the worker sends it within seconds)`,
    () => setOrderRef(`TEST-SO-${Date.now().toString(36).toUpperCase()}`),
  );
  const retry = useInventoryAction(
    (id: string) => api<OutboundCommand>(`/v1/admin/integrations/outbound/${id}/retry`, { method: 'POST' }),
    'Export queued again with the same reference',
  );
  const reconcile = useInventoryAction(
    () =>
      api<{ compared: number; mismatches: number; issuesOpened: number }>(
        `/v1/admin/integrations/connections/${connectionId}/reconcile`,
        { method: 'POST' },
      ),
    (r) => `Compared ${r.compared} stock figures: ${r.mismatches} mismatch(es), ${r.issuesOpened} new`,
  );
  const resolve = useInventoryAction(
    (note: string) =>
      api<ReconciliationIssue>(`/v1/admin/integrations/discrepancies/${resolving!.issue.id}/resolve`, {
        method: 'POST',
        body: { decision: resolving!.decision, note },
      }),
    'Discrepancy resolved',
    () => setResolving(null),
  );

  if (!enabled) return <ForbiddenState />;
  if (conn.isLoading) return <LoadingState />;
  if (conn.error) return <ErrorState error={conn.error} onRetry={() => void conn.refetch()} />;
  const c = conn.data!;
  const ownershipDirty = ownership && JSON.stringify(ownership) !== JSON.stringify(c.ownership);
  const templateColumns = (active?.rules ?? []).flatMap((r) => (r.source ? [r.source] : []));

  return (
    <>
      <PageHeader
        title={c.name}
        description={
          <>
            <Link href={`/t/${tenantId}/integrations`}>Integrations</Link> · {c.connectorLabel} ·{' '}
            <StatusBadge status={c.status} />
          </>
        }
        actions={
          canManage &&
          c.status !== 'disconnected' && (
            <>
              {c.status === 'active' ? (
                <Button onClick={() => setStatusChange('paused')}>Pause</Button>
              ) : (
                <Button onClick={() => setStatusChange('active')}>Activate</Button>
              )}
              <Button variant="danger" onClick={() => setStatusChange('disconnected')}>
                Disconnect
              </Button>
            </>
          )
        }
      />
      {isSim && (
        <Alert tone="info">
          This connection talks to the built-in simulator: demo data, not a real ERP. Real vendor connectors
          are listed as blocked on the Integrations page until they are certified.
        </Alert>
      )}
      <nav aria-label="Connection sections" className="uc-row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            className="uc-btn"
            data-size="sm"
            data-variant={section === s.key ? 'primary' : 'ghost'}
            aria-current={section === s.key ? 'page' : undefined}
            onClick={() => setSection(s.key)}
          >
            {s.label}
            {s.key === 'discrepancies' && c.openIssues > 0 ? ` (${c.openIssues})` : ''}
            {s.key === 'outbound' && c.failedOutbound > 0 ? ` (${c.failedOutbound} failed)` : ''}
          </button>
        ))}
      </nav>
      {formError && <Alert tone="danger">{formError}</Alert>}

      {section === 'overview' && ownership && settings && (
        <>
          <section className="uc-grid" aria-label="Connection status">
            <div className="uc-card uc-stat">
              <span className="uc-muted">Freshness</span>
              <strong style={{ fontSize: 16 }}>{c.freshness}</strong>
            </div>
            <div className="uc-card uc-stat">
              <span className="uc-muted">Last successful sync</span>
              <strong style={{ fontSize: 16 }}>
                {c.lastSuccessAt ? formatDateTime(c.lastSuccessAt, tz) : 'Never'}
              </strong>
            </div>
            <div className="uc-card uc-stat">
              <span className="uc-muted">Open discrepancies</span>
              <strong>{c.openIssues}</strong>
            </div>
            <div className="uc-card uc-stat">
              <span className="uc-muted">Exports pending / failed</span>
              <strong>
                {c.pendingOutbound} / {c.failedOutbound}
              </strong>
            </div>
          </section>
          <Card title="Field ownership">
            <p className="uc-muted">
              Which system wins for each field. Imports never overwrite fields owned by commerce, and manual
              stock changes are refused for stock owned by the ERP.
            </p>
            <div className="uc-form-grid">
              {OWNED.map((o) => (
                <SelectField
                  key={o.key}
                  label={o.label}
                  value={ownership[o.key]}
                  disabled={!canManage}
                  onChange={(e) =>
                    setOwnership({ ...ownership, [o.key]: e.target.value as 'erp' | 'commerce' })
                  }
                  options={[
                    { value: 'erp', label: 'ERP / source system' },
                    { value: 'commerce', label: 'This platform' },
                  ]}
                />
              ))}
            </div>
            {ownershipDirty && (
              <div className="uc-row">
                <TextField
                  label="Reason (recorded in the audit log)"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <Button
                  variant="primary"
                  loading={saveConnection.isPending}
                  onClick={() => saveConnection.mutate({ ownership, reason }, { onError: fail })}
                >
                  Save ownership
                </Button>
              </div>
            )}
          </Card>
          <Card title="Import settings">
            <div className="uc-stack">
              <Checkbox
                label="Link existing products by SKU"
                description="Adopt a product already in the catalogue when its SKU matches (otherwise it is reported as a collision)"
                checked={settings.linkExistingBySku}
                disabled={!canManage}
                onChange={(e) => setSettings({ ...settings, linkExistingBySku: e.target.checked })}
              />
              {isSim && (
                <Checkbox
                  label="Send confirmed orders to this connection"
                  description="Each confirmed order is queued once (reference ORDER:<number>) and retried until the ERP acknowledges it"
                  checked={settings.exportOrders}
                  disabled={!canManage}
                  onChange={(e) => setSettings({ ...settings, exportOrders: e.target.checked })}
                />
              )}
              <div className="uc-form-grid">
                <TextField
                  label="Default location code"
                  value={settings.defaultLocationCode ?? ''}
                  disabled={!canManage}
                  hint="Used when a row has no location column"
                  onChange={(e) => setSettings({ ...settings, defaultLocationCode: e.target.value || null })}
                />
                <SelectField
                  label="Default product type"
                  value={settings.defaultProductType}
                  disabled={!canManage}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      defaultProductType: e.target.value as 'standard' | 'jewellery',
                    })
                  }
                  options={[
                    { value: 'standard', label: 'Standard' },
                    { value: 'jewellery', label: 'Jewellery' },
                  ]}
                />
              </div>
              <span className="uc-muted">
                Deleted / sold rows are always flagged for review, never deleted automatically.
              </span>
              {canManage && (
                <div>
                  <Button
                    loading={saveConnection.isPending}
                    onClick={() => saveConnection.mutate({ settings }, { onError: fail })}
                  >
                    Save settings
                  </Button>
                </div>
              )}
            </div>
          </Card>
          <Card title="Credentials">
            <p style={{ margin: 0 }}>
              Credential reference:{' '}
              <span className="uc-mono">{c.credentialRef ?? 'none (not needed for this connector)'}</span>
            </p>
            <p className="uc-muted" style={{ marginBottom: 0 }}>
              Only a pointer to your secret store is kept here; secrets are never stored or shown by this
              platform.
            </p>
          </Card>
        </>
      )}

      {section === 'sync' && (
        <>
          {c.status !== 'active' && (
            <Alert tone="warning">This connection is {c.status}; activate it to sync.</Alert>
          )}
          {isSim ? (
            <Card title="Simulator">
              {sim.data && (
                <div className="uc-stack">
                  <p style={{ margin: 0 }}>
                    Step <strong>{sim.data.tick}</strong>: {sim.data.description}
                  </p>
                  {canManage && (
                    <div className="uc-row">
                      <Button
                        variant="primary"
                        loading={pull.isPending}
                        disabled={c.status !== 'active'}
                        onClick={() => pull.mutate(undefined, { onError: fail })}
                      >
                        Pull from simulator
                      </Button>
                      <Button
                        loading={advance.isPending}
                        onClick={() => advance.mutate(undefined, { onError: fail })}
                      >
                        Advance one change
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </Card>
          ) : (
            <Card title="Upload a file">
              <div className="uc-stack">
                <p className="uc-muted" style={{ margin: 0 }}>
                  CSV (UTF-8) or Excel .xlsx, first sheet, header row required, up to 5,000 rows / 2.4 MB.
                  Uploading only creates a preview; nothing changes until you commit it.
                </p>
                {canManage && (
                  <div className="uc-row">
                    <label className="uc-btn" data-variant="primary">
                      {uploadFile.isPending ? 'Reading…' : 'Choose file'}
                      <input
                        type="file"
                        accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                        className="uc-sr-only"
                        aria-label="Upload CSV or Excel file"
                        disabled={c.status !== 'active' || uploadFile.isPending}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = '';
                          if (f) {
                            setUploadError(null);
                            uploadFile.mutate(f, {
                              onError: (err) =>
                                setUploadError(serverErrors(err).message ?? errorMessage(err)),
                            });
                          }
                        }}
                      />
                    </label>
                    <Button
                      onClick={() => download('import-template.csv', `${templateColumns.join(',')}\r\n`)}
                      disabled={!templateColumns.length}
                    >
                      Download CSV template
                    </Button>
                  </div>
                )}
                {uploadError && <Alert tone="danger">{uploadError}</Alert>}
              </div>
            </Card>
          )}
          <Card title="Sync jobs">
            <DataTable
              caption="Sync jobs"
              rows={jobs.data?.items}
              isLoading={jobs.isLoading}
              error={jobs.error}
              onRetry={() => void jobs.refetch()}
              rowKey={(j) => j.id}
              pagination={jobsPager.controls(jobs.data?.nextCursor)}
              empty={
                <EmptyState
                  title="No syncs yet"
                  description={isSim ? 'Pull from the simulator to start.' : 'Upload a file to start.'}
                />
              }
              columns={[
                {
                  key: 'when',
                  header: 'Started',
                  render: (j) => (
                    <Link href={`/t/${tenantId}/integrations/jobs/${j.id}`}>
                      {formatDateTime(j.createdAt, tz)}
                    </Link>
                  ),
                },
                { key: 'src', header: 'Source', render: (j) => j.fileName ?? `simulator step ${j.cursorTo}` },
                { key: 'status', header: 'Status', render: (j) => <StatusBadge status={j.status} /> },
                {
                  key: 'counts',
                  header: 'Rows',
                  render: (j) =>
                    `${j.counts.total} · +${j.counts.create} new · ${j.counts.update} changed · ${j.counts.unchanged} same${j.counts.error ? ` · ${j.counts.error} errors` : ''}`,
                },
                { key: 'by', header: 'By', render: (j) => j.createdBy ?? '—' },
              ]}
            />
          </Card>
        </>
      )}

      {section === 'mapping' && (
        <>
          <Card title={`Field mapping${active ? ` (version ${active.version} active)` : ''}`}>
            <p className="uc-muted">
              Map each column of your export to a platform field. Weights are converted exactly to grams from
              the unit you choose. Publishing creates a new version; earlier jobs keep the version they used.
            </p>
            <div className="uc-table-wrap">
              <table className="uc-table">
                <caption className="uc-sr-only">Mapping rules</caption>
                <thead>
                  <tr>
                    <th scope="col">Platform field</th>
                    <th scope="col">Source column</th>
                    <th scope="col">Transform</th>
                    <th scope="col">Weight unit</th>
                    <th scope="col">
                      <span className="uc-sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r, i) => (
                    <tr key={`${r.target}-${i}`}>
                      <td>
                        <SelectField
                          label={`Field ${i + 1}`}
                          hideLabel
                          value={r.target}
                          disabled={!canManage}
                          onChange={(e) =>
                            setRules((rs) =>
                              rs.map((x, j) =>
                                j === i ? { ...x, target: e.target.value as MappingRule['target'] } : x,
                              ),
                            )
                          }
                          options={MAPPING_TARGET_KEYS.map((k) => ({
                            value: k,
                            label: `${MAPPING_TARGETS[k].label}${MAPPING_TARGETS[k].required ? ' *' : ''}`,
                          }))}
                        />
                      </td>
                      <td>
                        <TextField
                          label={`Source column for ${r.target}`}
                          value={r.source ?? ''}
                          disabled={!canManage}
                          onChange={(e) =>
                            setRules((rs) =>
                              rs.map((x, j) => (j === i ? { ...x, source: e.target.value } : x)),
                            )
                          }
                        />
                      </td>
                      <td>
                        <SelectField
                          label={`Transform for ${r.target}`}
                          hideLabel
                          value={r.transform}
                          disabled={!canManage}
                          onChange={(e) =>
                            setRules((rs) =>
                              rs.map((x, j) =>
                                j === i ? { ...x, transform: e.target.value as MappingRule['transform'] } : x,
                              ),
                            )
                          }
                          options={[
                            { value: 'trim', label: 'Trim' },
                            { value: 'upper', label: 'UPPER' },
                            { value: 'lower', label: 'lower' },
                            { value: 'none', label: 'As is' },
                          ]}
                        />
                      </td>
                      <td>
                        {['grossWeight', 'netWeight', 'stoneWeight'].includes(r.target) ? (
                          <SelectField
                            label={`Unit for ${r.target}`}
                            hideLabel
                            value={r.weightUnit ?? 'g'}
                            disabled={!canManage}
                            onChange={(e) =>
                              setRules((rs) =>
                                rs.map((x, j) => (j === i ? { ...x, weightUnit: e.target.value as 'g' } : x)),
                              )
                            }
                            options={[
                              { value: 'g', label: 'grams' },
                              { value: 'mg', label: 'milligrams' },
                              { value: 'kg', label: 'kilograms' },
                              { value: 'ct', label: 'carats (stone only)' },
                            ]}
                          />
                        ) : (
                          <span className="uc-muted">—</span>
                        )}
                      </td>
                      <td>
                        {canManage && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}
                          >
                            Remove
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {canManage && (
              <div className="uc-row">
                <Button
                  size="sm"
                  onClick={() => {
                    const free =
                      MAPPING_TARGET_KEYS.find((k) => !rules.some((r) => r.target === k)) ?? 'title';
                    setRules((rs) => [...rs, { target: free, source: '', transform: 'trim' }]);
                  }}
                >
                  Add field
                </Button>
                <Button
                  variant="primary"
                  loading={publishMapping.isPending}
                  onClick={() => publishMapping.mutate(undefined, { onError: fail })}
                >
                  Publish as new version
                </Button>
              </div>
            )}
          </Card>
          <Card title="Try the mapping on sample rows">
            <div className="uc-stack">
              <div className="uc-field">
                <label htmlFor="mapping-sample">Paste a header row and a few data rows (CSV)</label>
                <textarea
                  id="mapping-sample"
                  className="uc-textarea uc-mono"
                  rows={5}
                  value={sample}
                  onChange={(e) => setSample(e.target.value)}
                />
              </div>
              <div>
                <Button
                  loading={runPreview.isPending}
                  disabled={!sample.trim()}
                  onClick={() => runPreview.mutate(undefined, { onError: fail })}
                >
                  Preview
                </Button>
              </div>
              {preview && (
                <div className="uc-table-wrap">
                  <table className="uc-table">
                    <caption className="uc-sr-only">Mapping preview</caption>
                    <thead>
                      <tr>
                        <th scope="col">#</th>
                        <th scope="col">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((r, i) => (
                        <tr key={i}>
                          <td>{i + 1}</td>
                          <td>
                            {r.errors.length ? (
                              <span className="uc-error">
                                {r.errors.map((e) => `${e.field}: ${e.message}`).join(' · ')}
                              </span>
                            ) : (
                              <span className="uc-mono">
                                {r.record!.recordType} {r.record!.sku} · {r.record!.title ?? '—'} · qty{' '}
                                {r.record!.quantity ?? '—'} {r.record!.unit} ·{' '}
                                {r.record!.location ?? 'no location'}
                                {r.record!.grossG ? ` · gross ${r.record!.grossG} g` : ''}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Card>
        </>
      )}

      {section === 'records' && (
        <Card title="Linked records">
          <div className="uc-filters" role="search">
            <TextField label="External ID" value={recQ} onChange={(e) => setRecQ(e.target.value)} />
          </div>
          <DataTable
            caption="Linked records"
            rows={records.data?.items}
            isLoading={records.isLoading}
            error={records.error}
            rowKey={(r) => `${r.recordType}-${r.externalId}`}
            pagination={recPager.controls(records.data?.nextCursor)}
            empty={
              <EmptyState
                title="Nothing linked yet"
                description="Records appear after the first committed sync."
              />
            }
            columns={[
              {
                key: 'ext',
                header: 'External ID',
                render: (r) => <span className="uc-mono">{r.externalId}</span>,
              },
              { key: 'type', header: 'Type', render: (r) => r.recordType },
              { key: 'label', header: 'Linked to', render: (r) => r.label },
              { key: 'ver', header: 'Source version', render: (r) => r.externalVersion ?? '—' },
              {
                key: 'del',
                header: 'Status',
                render: (r) =>
                  r.deletedAt ? (
                    <Badge tone="warning">deleted in source</Badge>
                  ) : (
                    <Badge tone="success">linked</Badge>
                  ),
              },
              { key: 'at', header: 'Updated', render: (r) => formatDateTime(r.updatedAt, tz) },
            ]}
          />
        </Card>
      )}

      {section === 'discrepancies' && (
        <Card
          title="Discrepancies"
          actions={
            canManage && (
              <Button
                loading={reconcile.isPending}
                onClick={() => reconcile.mutate(undefined, { onError: fail })}
              >
                Compare stock now
              </Button>
            )
          }
        >
          <div className="uc-filters">
            <SelectField
              label="Status"
              value={issueStatus}
              onChange={(e) => setIssueStatus(e.target.value as 'open' | 'resolved')}
              options={[
                { value: 'open', label: 'Open' },
                { value: 'resolved', label: 'Resolved' },
              ]}
            />
          </div>
          <DataTable
            caption="Discrepancies"
            rows={issues.data?.items}
            isLoading={issues.isLoading}
            error={issues.error}
            rowKey={(i) => i.id}
            empty={
              <EmptyState
                title={issueStatus === 'open' ? 'No open discrepancies' : 'None resolved yet'}
                description="The source system and this platform agree."
              />
            }
            columns={[
              { key: 'at', header: 'Found', render: (i) => formatDateTime(i.createdAt, tz) },
              { key: 'kind', header: 'Kind', render: (i) => i.kind.replace(/_/g, ' ') },
              {
                key: 'what',
                header: 'Item',
                render: (i) => (
                  <>
                    {i.variant ? (
                      <Link href={`/t/${tenantId}/inventory/variants/${i.variant.id}`} className="uc-mono">
                        {i.variant.sku}
                      </Link>
                    ) : (
                      <span className="uc-mono">
                        {String((i.details as Record<string, unknown>).externalId ?? '')}
                      </span>
                    )}{' '}
                    {i.location?.name}
                  </>
                ),
              },
              {
                key: 'details',
                header: 'Details',
                render: (i) => {
                  const d = i.details as Record<string, string>;
                  return d.erp !== undefined ? (
                    <span>
                      Source: <strong>{d.erp}</strong> · here: <strong>{d.commerce}</strong>
                      {d.heldOrCommitted ? ` · held ${d.heldOrCommitted}` : ''}
                    </span>
                  ) : (
                    <span className="uc-muted">{d.message ?? JSON.stringify(d)}</span>
                  );
                },
              },
              {
                key: 'act',
                header: 'Resolution',
                render: (i) =>
                  i.status === 'open' ? (
                    can('reconciliation.resolve') ? (
                      <span className="uc-row">
                        {i.kind === 'erp_stock_mismatch' &&
                          (i.details as Record<string, string>).erp !== undefined && (
                            <Button
                              size="sm"
                              onClick={() => setResolving({ issue: i, decision: 'accept_erp' })}
                            >
                              Take source value
                            </Button>
                          )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setResolving({ issue: i, decision: 'keep_commerce' })}
                        >
                          Keep ours
                        </Button>
                      </span>
                    ) : (
                      <StatusBadge status="open" />
                    )
                  ) : (
                    <span>
                      {i.resolvedBy?.name}: {i.resolutionNote}
                    </span>
                  ),
              },
            ]}
          />
        </Card>
      )}

      {section === 'outbound' && (
        <>
          {isSim && canManage && (
            <Card title="Send a test order">
              <div className="uc-stack">
                <p className="uc-muted" style={{ margin: 0 }}>
                  Checkout will use this same pipeline (Phase 07). Each order has a stable reference, so
                  retries after a timeout never create a second ERP order.
                </p>
                <div className="uc-form-grid">
                  <TextField
                    label="Order reference"
                    value={orderRef}
                    onChange={(e) => setOrderRef(e.target.value)}
                  />
                  <TextField label="SKU" value={orderSku} onChange={(e) => setOrderSku(e.target.value)} />
                  <TextField
                    label="Quantity"
                    inputMode="decimal"
                    value={orderQty}
                    onChange={(e) => setOrderQty(e.target.value)}
                  />
                </div>
                <div>
                  <Button
                    variant="primary"
                    loading={testOrder.isPending}
                    onClick={() => testOrder.mutate(undefined, { onError: fail })}
                  >
                    Queue export
                  </Button>
                </div>
                <div className="uc-form-grid">
                  <TextField
                    label="Simulate outages (next N attempts fail)"
                    inputMode="numeric"
                    value={failNext}
                    onChange={(e) => setFailNext(e.target.value)}
                  />
                  <TextField
                    label="Simulate timeouts after acceptance (next N)"
                    inputMode="numeric"
                    value={timeoutNext}
                    onChange={(e) => setTimeoutNext(e.target.value)}
                  />
                </div>
                <div>
                  <Button
                    loading={failures.isPending}
                    onClick={() => failures.mutate(undefined, { onError: fail })}
                  >
                    Apply simulated failures
                  </Button>
                  {sim.data && (
                    <span className="uc-muted">
                      {' '}
                      Now: {sim.data.failNext} outage(s), {sim.data.timeoutNext} timeout(s) queued · ERP has
                      received {sim.data.receivedOrders} order(s)
                    </span>
                  )}
                </div>
              </div>
            </Card>
          )}
          {!isSim && (
            <Alert tone="info">
              File connections cannot receive orders. Order export needs a connector that supports it.
            </Alert>
          )}
          <Card
            title="Exports"
            actions={
              <Button size="sm" onClick={() => void outbound.refetch()}>
                Refresh
              </Button>
            }
          >
            <DataTable
              caption="Outbound commands"
              rows={outbound.data?.items}
              isLoading={outbound.isLoading}
              error={outbound.error}
              rowKey={(o) => o.id}
              pagination={outPager.controls(outbound.data?.nextCursor)}
              empty={
                <EmptyState
                  title="No exports yet"
                  description="Queued orders appear here with their delivery state."
                />
              }
              columns={[
                {
                  key: 'ref',
                  header: 'Reference',
                  render: (o) => <span className="uc-mono">{o.reference}</span>,
                },
                { key: 'status', header: 'Status', render: (o) => <StatusBadge status={o.status} /> },
                { key: 'att', header: 'Attempts', render: (o) => o.attempts },
                { key: 'ext', header: 'ERP order', render: (o) => o.externalRef ?? '—' },
                {
                  key: 'err',
                  header: 'Last error',
                  render: (o) => <span className="uc-muted">{o.lastError ?? '—'}</span>,
                },
                {
                  key: 'act',
                  header: 'Actions',
                  render: (o) =>
                    o.status === 'failed' && canManage ? (
                      <Button
                        size="sm"
                        loading={retry.isPending && retry.variables === o.id}
                        onClick={() => retry.mutate(o.id, { onError: fail })}
                      >
                        Retry
                      </Button>
                    ) : null,
                },
              ]}
            />
          </Card>
        </>
      )}

      <ConfirmDialog
        open={statusChange !== null}
        title={
          statusChange === 'disconnected'
            ? 'Disconnect this connection'
            : statusChange === 'paused'
              ? 'Pause syncing'
              : 'Activate syncing'
        }
        description={
          statusChange === 'disconnected'
            ? 'Syncing and order export stop permanently for this connection. Imported products, pieces and stock stay; their link to the source remains for audit.'
            : statusChange === 'paused'
              ? 'No new syncs or exports until you activate it again.'
              : 'Syncs and order export resume.'
        }
        confirmLabel={statusChange === 'disconnected' ? 'Disconnect' : 'Confirm'}
        tone={statusChange === 'disconnected' ? 'danger' : 'primary'}
        requireReason={statusChange === 'disconnected'}
        loading={saveConnection.isPending}
        error={saveConnection.error ? errorMessage(saveConnection.error) : null}
        onConfirm={(r) => saveConnection.mutate({ status: statusChange, ...(r ? { reason: r } : {}) })}
        onClose={() => setStatusChange(null)}
      />
      <ConfirmDialog
        open={resolving !== null}
        title={resolving?.decision === 'accept_erp' ? 'Take the source value' : 'Keep our value'}
        description={
          resolving?.decision === 'accept_erp'
            ? 'Stock here is corrected to the source figure with a ledger adjustment (reason: ERP reconciliation).'
            : 'Nothing changes here; the difference is recorded as reviewed.'
        }
        confirmLabel="Resolve"
        tone="primary"
        requireReason
        loading={resolve.isPending}
        error={resolve.error ? errorMessage(resolve.error) : null}
        onConfirm={(note) => resolve.mutate(note)}
        onClose={() => setResolving(null)}
      />
    </>
  );
}
