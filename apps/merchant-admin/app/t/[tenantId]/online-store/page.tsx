'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PreviewToken, Redirect, SiteDocument, StoreDomain } from '@uc/contracts';
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
  TextField,
  errorMessage,
  formatDateTime,
  useToast,
} from '@uc/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ChannelPicker, useStorefrontChannels } from '../../../../lib/growth';
import { useTenant, useTenantQuery } from '../../../../lib/tenant';

type DocRow = Omit<SiteDocument, 'draft' | 'published' | 'versions'> & { title: string };

export default function OnlineStorePage() {
  const { api, can, tenantId, context } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const enabled = can('content.manage') && context.features.includes('online_store');
  const { channels } = useStorefrontChannels(enabled);
  const [channelId, setChannelId] = useState('');
  const docs = useTenantQuery<{ items: DocRow[] }>(
    ['online-store', 'docs', channelId],
    '/v1/admin/online-store/documents',
    { channelId },
    enabled && !!channelId,
  );
  const domains = useTenantQuery<{ items: StoreDomain[] }>(
    ['online-store', 'domains', channelId],
    '/v1/admin/online-store/domains',
    { channelId },
    enabled && !!channelId,
  );
  const redirects = useTenantQuery<{ items: Redirect[] }>(
    ['online-store', 'redirects', channelId],
    '/v1/admin/online-store/redirects',
    { channelId },
    enabled && !!channelId,
  );
  const refresh = () => void qc.invalidateQueries({ queryKey: ['t', tenantId, 'online-store'] });
  const [newPage, setNewPage] = useState(false);
  const [page, setPage] = useState({ title: '', slug: '' });
  const [hostname, setHostname] = useState('');
  const [redirect, setRedirect] = useState({ fromPath: '', toPath: '', statusCode: '301' });
  const [preview, setPreview] = useState<PreviewToken | null>(null);
  const createPage = useMutation({
    mutationFn: () =>
      api<SiteDocument>('/v1/admin/online-store/pages', {
        method: 'POST',
        body: { channelId, slug: page.slug.trim(), content: { title: page.title.trim(), blocks: [] } },
      }),
    onSuccess: (d) => {
      setNewPage(false);
      refresh();
      window.location.assign(`/t/${tenantId}/online-store/${d.id}`);
    },
  });
  const mintPreview = useMutation({
    mutationFn: () =>
      api<PreviewToken>('/v1/admin/online-store/preview-tokens', { method: 'POST', body: { channelId } }),
    onSuccess: setPreview,
  });
  const addDomain = useMutation({
    mutationFn: () =>
      api('/v1/admin/online-store/domains', {
        method: 'POST',
        body: { channelId, hostname: hostname.trim() },
      }),
    onSuccess: () => {
      setHostname('');
      refresh();
      toast('Domain added — create the DNS record, then verify');
    },
  });
  const verify = useMutation({
    mutationFn: (id: string) => api(`/v1/admin/online-store/domains/${id}/verify`, { method: 'POST' }),
    onSuccess: () => toast('Domain verified'),
    onSettled: refresh,
  });
  const removeDomain = useMutation({
    mutationFn: (id: string) => api(`/v1/admin/online-store/domains/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const addRedirect = useMutation({
    mutationFn: () =>
      api('/v1/admin/online-store/redirects', {
        method: 'POST',
        body: {
          channelId,
          fromPath: redirect.fromPath.trim(),
          toPath: redirect.toPath.trim(),
          statusCode: Number.parseInt(redirect.statusCode, 10),
        },
      }),
    onSuccess: () => {
      setRedirect({ fromPath: '', toPath: '', statusCode: '301' });
      refresh();
    },
  });
  const removeRedirect = useMutation({
    mutationFn: (id: string) => api(`/v1/admin/online-store/redirects/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  if (!enabled) return <ForbiddenState />;
  const previewUrl = preview?.hostname
    ? `http://${preview.hostname}:3103/?preview=${encodeURIComponent(preview.token)}`
    : null;
  return (
    <>
      <PageHeader
        title="Online Store"
        description="Theme, menus, announcement banner and pages. Changes are drafts until you publish; shoppers only see published versions."
        actions={
          channelId && (
            <>
              <Button onClick={() => mintPreview.mutate()} loading={mintPreview.isPending}>
                Preview drafts
              </Button>
              <Button variant="primary" onClick={() => setNewPage(true)}>
                New page
              </Button>
            </>
          )
        }
      />
      <ChannelPicker value={channelId} onChange={setChannelId} channels={channels} />
      {preview && (
        <Alert tone="info" title="Preview link (valid 15 minutes)">
          {previewUrl ? (
            <a href={previewUrl} target="_blank" rel="noreferrer">
              Open the storefront with drafts
            </a>
          ) : (
            'This storefront has no verified domain yet.'
          )}{' '}
          — expires {formatDateTime(preview.expiresAt, context.tenant.timezone)}.
        </Alert>
      )}
      <Card title="Content">
        <DataTable
          caption="Content"
          rows={docs.data?.items}
          isLoading={docs.isLoading}
          error={docs.error}
          rowKey={(d) => d.id}
          empty={<EmptyState title="Nothing yet" />}
          columns={[
            {
              key: 't',
              header: 'Item',
              render: (d) => <Link href={`/t/${tenantId}/online-store/${d.id}`}>{d.title}</Link>,
            },
            {
              key: 'k',
              header: 'Type',
              render: (d) => (d.kind === 'page' ? `Page /pages/${d.key}` : d.kind),
            },
            {
              key: 's',
              header: 'Status',
              render: (d) => (
                <>
                  <Badge tone={d.live ? 'success' : undefined}>
                    {d.live ? `Live v${d.publishedVersion}` : 'Not published'}
                  </Badge>{' '}
                  {d.live && d.hasChanges && <Badge tone="warning">Unpublished changes</Badge>}
                </>
              ),
            },
            {
              key: 'u',
              header: 'Draft saved',
              render: (d) => formatDateTime(d.draftUpdatedAt, context.tenant.timezone),
            },
          ]}
        />
      </Card>
      <Card title="Domains">
        <DataTable
          caption="Domains"
          rows={domains.data?.items}
          isLoading={domains.isLoading}
          error={domains.error}
          rowKey={(d) => d.id}
          empty={<EmptyState title="No domains" />}
          columns={[
            { key: 'h', header: 'Domain', render: (d) => <span className="uc-mono">{d.hostname}</span> },
            {
              key: 's',
              header: 'Status',
              render: (d) => (
                <>
                  <Badge tone={d.status === 'verified' ? 'success' : 'warning'}>{d.status}</Badge>{' '}
                  {d.isPrimary && <Badge>primary</Badge>}
                </>
              ),
            },
            {
              key: 'r',
              header: 'DNS record to add',
              render: (d) =>
                d.verificationRecord ? (
                  <span className="uc-mono">
                    TXT {d.verificationRecord.name} = {d.verificationRecord.value}
                  </span>
                ) : (
                  '—'
                ),
            },
            {
              key: 'e',
              header: 'Last check',
              render: (d) =>
                d.lastCheckError ??
                (d.lastCheckAt ? formatDateTime(d.lastCheckAt, context.tenant.timezone) : '—'),
            },
            {
              key: 'a',
              header: 'Actions',
              render: (d) => (
                <div className="uc-row">
                  {d.status === 'pending' && (
                    <Button
                      size="sm"
                      variant="primary"
                      loading={verify.isPending && verify.variables === d.id}
                      onClick={() => verify.mutate(d.id)}
                    >
                      Verify
                    </Button>
                  )}
                  {!d.isPrimary && (
                    <Button size="sm" onClick={() => removeDomain.mutate(d.id)}>
                      Remove
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
        />
        {verify.error && <Alert tone="danger">{errorMessage(verify.error)}</Alert>}
        <div className="uc-row" style={{ alignItems: 'flex-end' }}>
          <TextField
            label="Add a domain"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder="shop.example.com"
          />
          <Button
            disabled={!hostname.trim()}
            loading={addDomain.isPending}
            onClick={() => addDomain.mutate()}
          >
            Add domain
          </Button>
        </div>
        {addDomain.error && <Alert tone="danger">{errorMessage(addDomain.error)}</Alert>}
        <span className="uc-hint">
          A domain only serves your store after the DNS TXT record proves you control it. Certificates for
          custom domains are set up at deployment.
        </span>
      </Card>
      <Card title="Redirects">
        <DataTable
          caption="Redirects"
          rows={redirects.data?.items}
          isLoading={redirects.isLoading}
          error={redirects.error}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No redirects" />}
          columns={[
            { key: 'f', header: 'From', render: (r) => <span className="uc-mono">{r.fromPath}</span> },
            { key: 't', header: 'To', render: (r) => <span className="uc-mono">{r.toPath}</span> },
            {
              key: 'c',
              header: 'Type',
              render: (r) => (r.statusCode === 301 ? 'Permanent (301)' : 'Temporary (302)'),
            },
            {
              key: 'a',
              header: 'Actions',
              render: (r) => (
                <Button size="sm" onClick={() => removeRedirect.mutate(r.id)}>
                  Remove
                </Button>
              ),
            },
          ]}
        />
        <div className="uc-form-grid">
          <TextField
            label="From path"
            value={redirect.fromPath}
            onChange={(e) => setRedirect({ ...redirect, fromPath: e.target.value })}
            placeholder="/old-page"
          />
          <TextField
            label="To"
            value={redirect.toPath}
            onChange={(e) => setRedirect({ ...redirect, toPath: e.target.value })}
            placeholder="/pages/about"
          />
          <SelectField
            label="Type"
            value={redirect.statusCode}
            onChange={(e) => setRedirect({ ...redirect, statusCode: e.target.value })}
            options={[
              { value: '301', label: 'Permanent (301)' },
              { value: '302', label: 'Temporary (302)' },
            ]}
          />
        </div>
        {addRedirect.error && <Alert tone="danger">{errorMessage(addRedirect.error)}</Alert>}
        <div className="uc-row">
          <Button
            disabled={!redirect.fromPath.trim() || !redirect.toPath.trim()}
            loading={addRedirect.isPending}
            onClick={() => addRedirect.mutate()}
          >
            Add redirect
          </Button>
        </div>
      </Card>
      <Dialog
        open={newPage}
        title="New page"
        onClose={() => setNewPage(false)}
        footer={
          <>
            <Button onClick={() => setNewPage(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!page.title.trim() || !page.slug.trim()}
              loading={createPage.isPending}
              onClick={() => createPage.mutate()}
            >
              Create draft
            </Button>
          </>
        }
      >
        <TextField
          label="Title"
          value={page.title}
          onChange={(e) =>
            setPage({
              title: e.target.value,
              slug:
                page.slug ||
                e.target.value
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')
                  .replace(/^-|-$/g, ''),
            })
          }
        />
        <TextField
          label="Address"
          value={page.slug}
          onChange={(e) => setPage({ ...page, slug: e.target.value })}
          hint="Shown as /pages/<address>"
        />
        {createPage.error && <Alert tone="danger">{errorMessage(createPage.error)}</Alert>}
      </Dialog>
    </>
  );
}
