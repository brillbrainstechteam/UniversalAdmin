'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MetalRate, Page, PricingCatalogOptions, RateProvider, RateSource } from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  ForbiddenState,
  PageHeader,
  SelectField,
  StatusBadge,
  TextField,
  errorMessage,
  formatDateTime,
  useCursorPagination,
  useToast,
} from '@uc/ui';
import { useState } from 'react';
import { serverErrors } from '../../../../../lib/forms';
import { PricingTabs, majorMoney } from '../../../../../lib/pricing';
import { ProposeRateDialog, RateDecisionButtons } from '../../../../../lib/rates';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

function AddSourceDialog({ provider, onClose }: { provider: RateProvider; onClose: () => void }) {
  const { api, tenantId } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ name: provider.label, credentialRef: '', licenceRef: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api('/v1/admin/rates/sources', {
        method: 'POST',
        body: {
          providerKey: provider.key,
          name: form.name,
          credentialRef: form.credentialRef || null,
          licenceRef: form.licenceRef || null,
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'rates'] });
      toast('Source added');
      onClose();
    },
    onError: (e) => {
      const r = serverErrors(e);
      setErrors(r.fields);
      setMessage(r.message);
    },
  });
  return (
    <Dialog
      open
      title={`Add ${provider.label}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Add source
          </Button>
        </>
      }
    >
      <div className="uc-form-grid">
        <TextField
          label="Name"
          value={form.name}
          error={errors.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <TextField
          label="Credential reference (optional)"
          value={form.credentialRef}
          error={errors.credentialRef}
          onChange={(e) => setForm({ ...form, credentialRef: e.target.value })}
          hint="A secret-store reference such as vault:rates/key — never the secret itself"
        />
        <TextField
          label="Licence reference (optional)"
          value={form.licenceRef}
          onChange={(e) => setForm({ ...form, licenceRef: e.target.value })}
        />
      </div>
      {provider.simulated && (
        <Alert tone="warning">
          Simulated values are test data. They are labelled SIMULATED everywhere and still need approval.
        </Alert>
      )}
      {message && <Alert tone="danger">{message}</Alert>}
    </Dialog>
  );
}

function Sources() {
  const { api, can, tenantId, context } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const sources = useTenantQuery<{ items: RateSource[]; providers: RateProvider[] }>(
    ['rates', 'sources'],
    '/v1/admin/rates/sources',
  );
  const [adding, setAdding] = useState<RateProvider | null>(null);
  const [minutesAgo, setMinutesAgo] = useState('0');
  const pull = useMutation({
    mutationFn: (s: RateSource) =>
      api<{ proposed: MetalRate[]; skipped: { code: string; message: string }[] }>(
        `/v1/admin/rates/sources/${s.id}/pull`,
        {
          method: 'POST',
          body: { asOfMinutesAgo: /^\d{1,6}$/.test(minutesAgo) ? Number.parseInt(minutesAgo, 10) : 0 },
        },
      ),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'rates'] });
      toast(
        `${r.proposed.length} simulated rate(s) proposed${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`,
      );
    },
  });
  const edit = can('rates.edit');
  return (
    <Card title="Rate sources">
      <DataTable
        caption="Rate sources"
        rows={sources.data?.items}
        isLoading={sources.isLoading}
        error={sources.error}
        rowKey={(s) => s.id}
        empty={<EmptyState title="No sources" />}
        columns={[
          {
            key: 'name',
            header: 'Source',
            render: (s) => (
              <span className="uc-row">
                {s.name} {s.simulated && <Badge tone="warning">SIMULATED</Badge>}
              </span>
            ),
          },
          {
            key: 'kind',
            header: 'Kind',
            render: (s) => (s.kind === 'manual' ? 'Manual entry' : s.providerKey),
          },
          {
            key: 'cred',
            header: 'Credential',
            render: (s) => <span className="uc-mono">{s.credentialRef ?? '—'}</span>,
          },
          {
            key: 'last',
            header: 'Last pulled',
            render: (s) => (s.lastPulledAt ? formatDateTime(s.lastPulledAt, context.tenant.timezone) : '—'),
          },
          {
            key: 'act',
            header: 'Actions',
            render: (s) =>
              edit && s.kind === 'provider' ? (
                <Button size="sm" loading={pull.isPending} onClick={() => pull.mutate(s)}>
                  Pull values<span className="uc-sr-only"> from {s.name}</span>
                </Button>
              ) : null,
          },
        ]}
      />
      {edit && sources.data?.items.some((s) => s.simulated) && (
        <div className="uc-filters">
          <TextField
            label="Simulate a source time this many minutes ago"
            inputMode="numeric"
            value={minutesAgo}
            onChange={(e) => setMinutesAgo(e.target.value)}
            hint="Test the stale-rate policy (0 = now)"
          />
        </div>
      )}
      {pull.error && <Alert tone="danger">{errorMessage(pull.error)}</Alert>}
      <h3>Providers</h3>
      <ul className="uc-stack" style={{ listStyle: 'none', padding: 0 }}>
        {sources.data?.providers.map((p) => (
          <li key={p.key} className="uc-card">
            <div className="uc-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <span className="uc-row">
                <strong>{p.label}</strong>
                <Badge tone={p.tier === 'available' ? 'success' : 'warning'}>{p.tier}</Badge>
                {p.simulated && <Badge tone="warning">test data</Badge>}
              </span>
              {edit && p.tier === 'available' && (
                <Button size="sm" onClick={() => setAdding(p)}>
                  Add<span className="uc-sr-only"> {p.label}</span>
                </Button>
              )}
            </div>
            <p className="uc-muted">{p.description}</p>
            {p.blockedBy.length > 0 && (
              <>
                <span>Waiting for:</span>
                <ul>
                  {p.blockedBy.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </>
            )}
          </li>
        ))}
      </ul>
      {adding && <AddSourceDialog provider={adding} onClose={() => setAdding(null)} />}
    </Card>
  );
}

export default function RatesPage() {
  const { can, context } = useTenant();
  const enabled = can('rates.read') && context.features.includes('metal_rates');
  const tz = context.tenant.timezone;
  const [status, setStatus] = useState('');
  const [purityId, setPurityId] = useState('');
  const [proposing, setProposing] = useState(false);
  const filters = { status, purityId };
  const pager = useCursorPagination(JSON.stringify(filters));
  const list = useTenantQuery<Page<MetalRate>>(
    ['rates', 'list'],
    '/v1/admin/rates',
    { ...filters, cursor: pager.cursor, limit: 25 },
    enabled,
  );
  const options = useTenantQuery<PricingCatalogOptions>(
    ['pricing', 'options'],
    '/v1/admin/pricing/options',
    undefined,
    enabled && can('pricing.read'),
  );
  if (!enabled) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="Metal rates"
        description="Append-only rate history. A rate is used only after a second person approves it; to go back, propose the old value again."
        actions={
          can('rates.edit') && (
            <Button variant="primary" onClick={() => setProposing(true)}>
              Propose rate
            </Button>
          )
        }
      />
      <PricingTabs />
      <Card title="History">
        <div className="uc-filters" role="search">
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: '', label: 'Any' },
              { value: 'proposed', label: 'Waiting approval' },
              { value: 'approved', label: 'Approved' },
              { value: 'rejected', label: 'Rejected' },
            ]}
          />
          <SelectField
            label="Purity"
            value={purityId}
            onChange={(e) => setPurityId(e.target.value)}
            options={[
              { value: '', label: 'All' },
              ...(options.data?.purities ?? []).map((p) => ({
                value: p.id,
                label: `${p.metal} · ${p.label}`,
              })),
            ]}
          />
        </div>
        <DataTable
          caption="Rate history"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(r) => r.id}
          pagination={pager.controls(list.data?.nextCursor)}
          empty={<EmptyState title="No rates" description="Propose a rate to get started." />}
          columns={[
            { key: 'purity', header: 'Purity', render: (r) => `${r.metal} · ${r.purity.label}` },
            {
              key: 'rate',
              header: 'Rate / g',
              render: (r) => (
                <span className="uc-mono">
                  {majorMoney(r.ratePerG, r.currency)}
                  {r.input.unit !== 'per_g' && (
                    <span className="uc-muted">
                      {' '}
                      ({r.input.value} {r.input.unit.replace('_', ' ')})
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              render: (r) => (
                <span className="uc-row">
                  <StatusBadge status={r.status} />
                  {r.isCurrent && <Badge tone="success">current</Badge>}
                  {r.stale && <Badge tone="danger">stale</Badge>}
                  {r.source.simulated && <Badge tone="warning">SIMULATED</Badge>}
                </span>
              ),
            },
            { key: 'asof', header: 'Source time', render: (r) => formatDateTime(r.sourceAsOf, tz) },
            {
              key: 'eff',
              header: 'Effective',
              render: (r) => (r.status === 'approved' ? formatDateTime(r.effectiveFrom, tz) : '—'),
            },
            {
              key: 'who',
              header: 'Proposed / decided',
              render: (r) => (
                <>
                  {r.proposedBy?.name ?? 'System'}
                  {r.decidedAt && ` → ${r.decidedBy?.name ?? 'withdrawn'}`}
                </>
              ),
            },
            {
              key: 'reason',
              header: 'Reason / note',
              render: (r) => [r.reason, r.decisionNote].filter(Boolean).join(' — '),
            },
            { key: 'act', header: 'Decision', render: (r) => <RateDecisionButtons rate={r} /> },
          ]}
        />
      </Card>
      <Sources />
      {proposing && <ProposeRateDialog onClose={() => setProposing(false)} />}
    </>
  );
}
