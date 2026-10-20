'use client';

import {
  currencyMinorUnits,
  formatMinor,
  type ReportDefinition,
  type ReportKey,
  type ReportResult,
} from '@uc/contracts';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  SelectField,
  TextField,
  errorMessage,
  formatDateTime,
} from '@uc/ui';
import { useState } from 'react';
import { useStorefrontChannels } from '../../../../lib/growth';
import { useTenant, useTenantQuery } from '../../../../lib/tenant';

export default function AnalyticsPage() {
  const { can, tenantId, context } = useTenant();
  const enabled = can('analytics.read') && context.features.includes('analytics');
  const catalogue = useTenantQuery<{ items: ReportDefinition[] }>(
    ['reports', 'list'],
    '/v1/admin/reports',
    undefined,
    enabled,
  );
  const { channels } = useStorefrontChannels(enabled);
  const [key, setKey] = useState<ReportKey>('sales');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [channelId, setChannelId] = useState('');
  const report = useTenantQuery<ReportResult>(
    ['reports', key, from, to, channelId],
    `/v1/admin/reports/${key}`,
    { from: from || undefined, to: to || undefined, channelId: channelId || undefined },
    enabled,
  );
  const [downloadError, setDownloadError] = useState<string | null>(null);
  if (!enabled) return <ForbiddenState />;
  const r = report.data;
  const mu = r?.currency ? currencyMinorUnits(r.currency) : 2;
  const cell = (unit: string | undefined, v: string | number | null | undefined) => {
    if (v === null || v === undefined) return '—';
    if (unit === 'money') return `${r!.currency} ${formatMinor(String(v), mu)}`;
    if (unit === 'percent') return `${v}%`;
    if (unit === 'grams') return `${v} g`;
    return String(v);
  };
  const download = async () => {
    setDownloadError(null);
    try {
      const qs = new URLSearchParams({
        format: 'csv',
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(channelId ? { channelId } : {}),
      });
      const res = await fetch(`/api/v1/admin/reports/${key}?${qs}`, {
        headers: { 'X-Tenant-Id': tenantId },
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `${key}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setDownloadError(errorMessage(e));
    }
  };
  const def = r?.definition ?? catalogue.data?.items.find((d) => d.key === key);
  return (
    <>
      <PageHeader
        title="Analytics"
        description="Reports computed from your own orders, stock and integrations. Every figure has a published formula."
        actions={<Button onClick={() => void download()}>Download CSV</Button>}
      />
      <div className="uc-filters" role="search">
        <SelectField
          label="Report"
          value={key}
          onChange={(e) => setKey(e.target.value as ReportKey)}
          options={(catalogue.data?.items ?? []).map((d) => ({ value: d.key, label: d.title }))}
        />
        {def?.filters.includes('date') && (
          <>
            <TextField label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <TextField label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </>
        )}
        {def?.filters.includes('channel') && channels.length > 0 && (
          <SelectField
            label="Storefront"
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            options={[{ value: '', label: 'All' }, ...channels.map((c) => ({ value: c.id, label: c.name }))]}
          />
        )}
      </div>
      {downloadError && <Alert tone="danger">{downloadError}</Alert>}
      {report.error ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : !r ? (
        <LoadingState />
      ) : (
        <>
          <Card title={r.definition.title}>
            <p className="uc-muted">
              {r.definition.description}{' '}
              {r.definition.filters.includes('date') &&
                `${r.filters.from} to ${r.filters.to} (${r.filters.timezone}). `}
              Generated {formatDateTime(r.generatedAt, context.tenant.timezone)} from {r.definition.source}.
            </p>
            {r.rows.length === 0 ? (
              <EmptyState title="No data for these filters" />
            ) : (
              <div className="uc-table-wrap">
                <table className="uc-table">
                  <caption className="uc-sr-only">{r.definition.title}</caption>
                  <thead>
                    <tr>
                      {r.definition.dimensions.map((d) => (
                        <th key={d.key} scope="col">
                          {d.label}
                        </th>
                      ))}
                      {r.definition.metrics.map((m) => (
                        <th key={m.key} scope="col">
                          {m.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {r.rows.map((row, i) => (
                      <tr key={i}>
                        {r.definition.dimensions.map((d) => (
                          <td key={d.key}>{String(row[d.key] ?? '—')}</td>
                        ))}
                        {r.definition.metrics.map((m) => (
                          <td key={m.key} className="uc-mono">
                            {cell(m.unit, row[m.key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                    <tr>
                      <th scope="row" colSpan={r.definition.dimensions.length}>
                        Total
                      </th>
                      {r.definition.metrics.map((m) => (
                        <td key={m.key} className="uc-mono">
                          <strong>{cell(m.unit, r.totals[m.key])}</strong>
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
            {r.definition.notes.map((n) => (
              <Alert key={n} tone="info">
                {n}
              </Alert>
            ))}
          </Card>
          <Card title="Metric definitions">
            <dl className="uc-stack">
              {r.definition.metrics.map((m) => (
                <div key={m.key}>
                  <dt>
                    <strong>{m.label}</strong>
                  </dt>
                  <dd className="uc-muted">{m.formula}</dd>
                </div>
              ))}
            </dl>
          </Card>
        </>
      )}
    </>
  );
}
