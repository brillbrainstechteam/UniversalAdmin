'use client';

import {
  DISCOVERY_STATUSES,
  type Connection,
  type ConnectorCatalog,
  type ConnectorView,
} from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  SelectField,
  StatusBadge,
  TextField,
  errorMessage,
} from '@uc/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { serverErrors } from '../../../../lib/forms';
import { useInventoryAction } from '../../../../lib/inventory';
import { useTenant, useTenantQuery } from '../../../../lib/tenant';

const DISCOVERY_FIELDS: { key: string; label: string }[] = [
  { key: 'contact', label: 'Vendor contact' },
  { key: 'edition', label: 'Software edition / version' },
  { key: 'hosting', label: 'Hosting (desktop, server, cloud)' },
  { key: 'integrationMethod', label: 'Integration method (API, export feed, ODBC…)' },
  { key: 'authentication', label: 'Authentication' },
  { key: 'exportFormat', label: 'Export format' },
  { key: 'identifierStability', label: 'Stable external IDs?' },
  { key: 'changeFeed', label: 'Change feed / modified-since' },
  { key: 'granularity', label: 'Tag-wise or design-wise stock; branches' },
  { key: 'media', label: 'Images / videos export' },
  { key: 'writeback', label: 'Order write-back' },
  { key: 'commercialTerms', label: 'Commercial terms' },
];

const STATUS_LABEL: Record<string, string> = {
  not_started: 'Not started',
  requested: 'Docs requested',
  docs_received: 'Docs received',
  sandbox_ready: 'Sandbox ready',
  pilot_passed: 'Pilot passed',
};

export default function IntegrationsPage() {
  const { can, tenantId, context, api } = useTenant();
  const router = useRouter();
  const enabled = can('integrations.read') && context.features.includes('integrations');
  const catalog = useTenantQuery<ConnectorCatalog>(
    ['integrations', 'catalog'],
    '/v1/admin/integrations/connectors',
    undefined,
    enabled,
  );
  const conns = useTenantQuery<{ items: Connection[] }>(
    ['integrations', 'connections'],
    '/v1/admin/integrations/connections',
    undefined,
    enabled,
  );
  const [connect, setConnect] = useState<ConnectorView | null>(null);
  const [name, setName] = useState('');
  const [credentialRef, setCredentialRef] = useState('');
  const [discovery, setDiscovery] = useState<ConnectorView | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [dStatus, setDStatus] = useState('not_started');
  const [notes, setNotes] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const create = useInventoryAction(
    () =>
      api<Connection>('/v1/admin/integrations/connections', {
        method: 'POST',
        body: { connectorKey: connect!.key, name, credentialRef: credentialRef || null },
      }),
    (c) => `Connection "${c.name}" created`,
    (c) => router.push(`/t/${tenantId}/integrations/connections/${c.id}`),
  );
  const saveDiscovery = useInventoryAction(
    () =>
      api<ConnectorCatalog>(`/v1/admin/integrations/connectors/${discovery!.key}/discovery`, {
        method: 'PUT',
        body: {
          version: discovery!.discovery?.version ?? 0,
          status: dStatus,
          answers: Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim() !== '')),
          notes: notes || null,
        },
      }),
    'Discovery checklist saved',
    () => setDiscovery(null),
  );

  if (!enabled) return <ForbiddenState />;
  if (catalog.isLoading) return <LoadingState />;
  if (catalog.error) return <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />;
  const items = catalog.data!.items;
  const canManage = can('integrations.manage');

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Connect an ERP or spreadsheet to import catalogue, pieces and stock. Only connectors that are built and tested can be connected; vendor connectors stay blocked until their documentation, test access and a pilot are in hand."
      />

      <Card title="Your connections">
        <DataTable
          caption="Connections"
          rows={conns.data?.items}
          isLoading={conns.isLoading}
          error={conns.error}
          onRetry={() => void conns.refetch()}
          rowKey={(c) => c.id}
          empty={
            <EmptyState
              title="No connections yet"
              description="Start with CSV / Excel import or the simulator below."
            />
          }
          columns={[
            {
              key: 'name',
              header: 'Connection',
              render: (c) => <Link href={`/t/${tenantId}/integrations/connections/${c.id}`}>{c.name}</Link>,
            },
            { key: 'type', header: 'Connector', render: (c) => c.connectorLabel },
            { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
            {
              key: 'fresh',
              header: 'Freshness',
              render: (c) => <span className="uc-muted">{c.freshness}</span>,
            },
            {
              key: 'attention',
              header: 'Needs attention',
              render: (c) =>
                c.openIssues || c.failedOutbound ? (
                  <span className="uc-row">
                    {c.openIssues > 0 && <Badge tone="warning">{c.openIssues} discrepancies</Badge>}
                    {c.failedOutbound > 0 && <Badge tone="danger">{c.failedOutbound} failed exports</Badge>}
                  </span>
                ) : (
                  <span className="uc-muted">—</span>
                ),
            },
          ]}
        />
      </Card>

      <h2>Connectors</h2>
      <section className="uc-grid" aria-label="Connector catalog">
        {items.map((c) => (
          <div key={c.key} className="uc-card uc-stack">
            <div className="uc-row" style={{ justifyContent: 'space-between' }}>
              <strong>{c.label}</strong>
              {c.status === 'available' ? (
                <Badge tone="success">available</Badge>
              ) : (
                <Badge tone="warning">blocked</Badge>
              )}
            </div>
            <span className="uc-muted">{c.vendor}</span>
            <span>{c.freshness}</span>
            {c.status === 'available' ? (
              <span className="uc-muted">
                Imports:{' '}
                {[
                  c.capabilities.importCatalog && 'catalogue',
                  c.capabilities.importStock && 'stock',
                  c.capabilities.importPieces && 'pieces',
                  c.capabilities.pushOrders && 'order export',
                ]
                  .filter(Boolean)
                  .join(', ')}
              </span>
            ) : (
              <div>
                <span className="uc-muted">Waiting for:</span>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {c.blockedOn.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
                <p className="uc-muted" style={{ marginBottom: 0 }}>
                  Discovery: <strong>{STATUS_LABEL[c.discovery?.status ?? 'not_started']}</strong>
                  {c.fallback ? ' · meanwhile use CSV / Excel file import' : ''}
                </p>
              </div>
            )}
            <div className="uc-row">
              {c.status === 'available' && canManage && (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    setConnect(c);
                    setName(c.key === 'simulator' ? 'Demo ERP (simulator)' : 'ERP file import');
                    setCredentialRef('');
                    setFieldErrors({});
                  }}
                >
                  Connect
                </Button>
              )}
              {c.status === 'blocked' && canManage && (
                <Button
                  size="sm"
                  onClick={() => {
                    setDiscovery(c);
                    setAnswers({ ...(c.discovery?.answers as Record<string, string> | undefined) });
                    setDStatus(c.discovery?.status ?? 'not_started');
                    setNotes(c.discovery?.notes ?? '');
                  }}
                >
                  Discovery checklist
                </Button>
              )}
              {c.references.map((r) => (
                <a key={r.url} href={r.url} target="_blank" rel="noreferrer noopener">
                  {r.label}
                </a>
              ))}
            </div>
          </div>
        ))}
      </section>

      <Card title="Blocked dependencies (waiting on third parties)">
        <p className="uc-muted">
          Everything below is deliberately not faked. Each item becomes buildable when the listed input
          arrives.
        </p>
        <DataTable
          caption="Blocked dependencies"
          rows={catalog.data!.blockedDependencies.map((d, i) => ({ ...d, id: String(i) }))}
          rowKey={(d) => d.id}
          empty={<EmptyState title="Nothing blocked" description="" />}
          columns={[
            { key: 'area', header: 'Area', render: (d) => <Badge>{d.area}</Badge> },
            { key: 'item', header: 'Item', render: (d) => d.item },
            { key: 'wait', header: 'Waiting for', render: (d) => d.waitingFor },
            { key: 'phase', header: 'Phase', render: (d) => d.phase },
          ]}
        />
      </Card>

      <Dialog
        open={connect !== null}
        title={`Connect ${connect?.label ?? ''}`}
        onClose={() => setConnect(null)}
        footer={
          <>
            <Button onClick={() => setConnect(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={create.isPending}
              onClick={() =>
                create.mutate(undefined, {
                  onError: (e) => setFieldErrors(serverErrors(e).fields),
                })
              }
            >
              Create connection
            </Button>
          </>
        }
      >
        <div className="uc-stack">
          {connect?.key === 'simulator' && (
            <Alert tone="info">
              The simulator is a built-in test double with demo data, not a real ERP. Use it to try imports,
              changes and order export safely.
            </Alert>
          )}
          <TextField
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={fieldErrors.name}
          />
          <TextField
            label="Credential reference (optional)"
            value={credentialRef}
            onChange={(e) => setCredentialRef(e.target.value)}
            error={fieldErrors.credentialRef}
            hint="A pointer to a secret in your secret store, e.g. vault:erp/main. Never paste the secret itself."
          />
          {create.error && !Object.keys(fieldErrors).length && (
            <Alert tone="danger">{errorMessage(create.error)}</Alert>
          )}
        </div>
      </Dialog>

      <Dialog
        open={discovery !== null}
        title={`${discovery?.label ?? ''} — vendor discovery`}
        onClose={() => setDiscovery(null)}
        footer={
          <>
            <Button onClick={() => setDiscovery(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={saveDiscovery.isPending}
              onClick={() => saveDiscovery.mutate(undefined)}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="uc-stack">
          <SelectField
            label="Status"
            value={dStatus}
            onChange={(e) => setDStatus(e.target.value)}
            options={DISCOVERY_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s]! }))}
          />
          {DISCOVERY_FIELDS.map((f) => (
            <TextField
              key={f.key}
              label={f.label}
              value={answers[f.key] ?? ''}
              onChange={(e) => setAnswers((a) => ({ ...a, [f.key]: e.target.value }))}
            />
          ))}
          <div className="uc-field">
            <label htmlFor="discovery-notes">Notes</label>
            <textarea
              id="discovery-notes"
              className="uc-textarea"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          {saveDiscovery.error && <Alert tone="danger">{errorMessage(saveDiscovery.error)}</Alert>}
        </div>
      </Dialog>
    </>
  );
}
