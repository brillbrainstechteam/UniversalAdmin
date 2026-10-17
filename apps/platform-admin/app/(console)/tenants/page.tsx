'use client';

import { PRESETS, PRESET_KEYS, type Page, type TenantSummary } from '@uc/contracts';
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  ForbiddenState,
  PageHeader,
  SelectField,
  StatusBadge,
  TextField,
  formatDateTime,
  useCursorPagination,
} from '@uc/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePlatformMe, usePlatformQuery } from '../../../lib/platform';

export default function TenantsPage() {
  const me = usePlatformMe();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  const [preset, setPreset] = useState('');
  const [sort, setSort] = useState('-createdAt');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const filters = { q: debounced, status, preset, sort };
  const pager = useCursorPagination(JSON.stringify(filters));
  const tenants = usePlatformQuery<Page<TenantSummary>>(
    ['tenants'],
    '/v1/platform/tenants',
    { ...filters, cursor: pager.cursor, limit: 25 },
    me.can('platform.tenants.read'),
  );
  if (!me.can('platform.tenants.read')) return <ForbiddenState />;

  return (
    <>
      <PageHeader
        title="Tenants"
        description="Merchants provisioned on the platform. Platform operators have no implicit access to merchant data."
        actions={
          me.can('platform.tenants.manage') && (
            <Link className="uc-btn" data-variant="primary" href="/tenants/new">
              Provision tenant
            </Link>
          )
        }
      />
      <Card>
        <div className="uc-filters" role="search">
          <TextField
            label="Search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name, slug or legal name"
          />
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: '', label: 'All' },
              { value: 'active', label: 'Active' },
              { value: 'suspended', label: 'Suspended' },
            ]}
          />
          <SelectField
            label="Preset"
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            options={[
              { value: '', label: 'All presets' },
              ...PRESET_KEYS.map((k) => ({ value: k, label: PRESETS[k].label })),
            ]}
          />
          <SelectField
            label="Sort"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            options={[
              { value: '-createdAt', label: 'Newest' },
              { value: 'createdAt', label: 'Oldest' },
              { value: 'displayName', label: 'Name A→Z' },
              { value: '-displayName', label: 'Name Z→A' },
            ]}
          />
        </div>
        <DataTable
          caption="Tenants"
          rows={tenants.data?.items}
          isLoading={tenants.isLoading}
          error={tenants.error}
          onRetry={() => void tenants.refetch()}
          rowKey={(t) => t.id}
          pagination={pager.controls(tenants.data?.nextCursor)}
          empty={<EmptyState title="No tenants match these filters" />}
          columns={[
            {
              key: 'name',
              header: 'Tenant',
              render: (t) => (
                <>
                  <Link href={`/tenants/${t.id}`}>{t.displayName}</Link>{' '}
                  {t.isDemo && <Badge tone="warning">Demo</Badge>}
                  <br />
                  <span className="uc-mono uc-muted">{t.slug}</span>
                </>
              ),
            },
            { key: 'preset', header: 'Preset', render: (t) => PRESETS[t.preset].label },
            { key: 'region', header: 'Region', render: (t) => `${t.countryCode} · ${t.defaultCurrency}` },
            { key: 'members', header: 'Active staff', render: (t) => t.memberCount },
            { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
            { key: 'created', header: 'Created', render: (t) => formatDateTime(t.createdAt) },
          ]}
        />
      </Card>
    </>
  );
}
