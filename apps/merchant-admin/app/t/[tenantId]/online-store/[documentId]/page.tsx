'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  BannerContent,
  ContentBlock,
  MenuContent,
  PageContent,
  SiteDocument,
  ThemeTokens,
} from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  SelectField,
  TextField,
  errorMessage,
  formatDateTime,
  useToast,
  useUnsavedChangesWarning,
} from '@uc/ui';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { fromLocalInput, toLocalInput } from '../../../../../lib/growth';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

type Content = Record<string, unknown>;

function ThemeEditor({ value, onChange }: { value: ThemeTokens; onChange: (v: ThemeTokens) => void }) {
  const color = (k: 'primaryColor' | 'accentColor' | 'backgroundColor' | 'textColor', label: string) => (
    <TextField
      label={label}
      type="color"
      value={value[k]}
      onChange={(e) => onChange({ ...value, [k]: e.target.value })}
    />
  );
  return (
    <div className="uc-form-grid">
      <TextField
        label="Store name shown"
        value={value.brandName}
        onChange={(e) => onChange({ ...value, brandName: e.target.value })}
      />
      {color('primaryColor', 'Primary colour')}
      {color('accentColor', 'Accent colour')}
      {color('backgroundColor', 'Background')}
      {color('textColor', 'Text')}
      <SelectField
        label="Font"
        value={value.fontFamily}
        onChange={(e) => onChange({ ...value, fontFamily: e.target.value as ThemeTokens['fontFamily'] })}
        options={[
          { value: 'system', label: 'System' },
          { value: 'sans', label: 'Sans-serif' },
          { value: 'serif', label: 'Serif' },
        ]}
      />
      <SelectField
        label="Corners"
        value={value.radius}
        onChange={(e) => onChange({ ...value, radius: e.target.value as ThemeTokens['radius'] })}
        options={['none', 'sm', 'md', 'lg'].map((r) => ({ value: r, label: r }))}
      />
      <TextField
        label="Logo URL (https, optional)"
        value={value.logoUrl ?? ''}
        onChange={(e) => onChange({ ...value, logoUrl: e.target.value.trim() || null })}
      />
    </div>
  );
}

function MenuEditor({ value, onChange }: { value: MenuContent; onChange: (v: MenuContent) => void }) {
  const set = (i: number, k: 'label' | 'href', v: string) =>
    onChange({ items: value.items.map((x, j) => (j === i ? { ...x, [k]: v } : x)) });
  return (
    <div className="uc-stack">
      {value.items.length === 0 && <span className="uc-muted">No links yet.</span>}
      {value.items.map((item, i) => (
        <div key={i} className="uc-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <TextField
            label={`Link ${i + 1} label`}
            value={item.label}
            onChange={(e) => set(i, 'label', e.target.value)}
          />
          <TextField
            label={`Link ${i + 1} target`}
            value={item.href}
            onChange={(e) => set(i, 'href', e.target.value)}
            hint="/pages/about or https://…"
          />
          <Button size="sm" onClick={() => onChange({ items: value.items.filter((_, j) => j !== i) })}>
            Remove
          </Button>
        </div>
      ))}
      <div className="uc-row">
        <Button
          size="sm"
          disabled={value.items.length >= 12}
          onClick={() => onChange({ items: [...value.items, { label: '', href: '/' }] })}
        >
          Add link
        </Button>
      </div>
    </div>
  );
}

function BannerEditor({ value, onChange }: { value: BannerContent; onChange: (v: BannerContent) => void }) {
  return (
    <div className="uc-form-grid">
      <TextField
        label="Message"
        value={value.message}
        onChange={(e) => onChange({ ...value, message: e.target.value })}
      />
      <TextField
        label="Link (optional)"
        value={value.linkHref ?? ''}
        onChange={(e) => onChange({ ...value, linkHref: e.target.value.trim() || null })}
      />
      <TextField
        label="Show from (optional)"
        type="datetime-local"
        value={toLocalInput(value.startsAt)}
        onChange={(e) => onChange({ ...value, startsAt: fromLocalInput(e.target.value) })}
      />
      <TextField
        label="Show until (optional)"
        type="datetime-local"
        value={toLocalInput(value.endsAt)}
        onChange={(e) => onChange({ ...value, endsAt: fromLocalInput(e.target.value) })}
      />
    </div>
  );
}

const NEW_BLOCK: Record<ContentBlock['type'], ContentBlock> = {
  heading: { type: 'heading', text: 'Heading', level: 2 },
  text: { type: 'text', text: 'Text' },
  image: { type: 'image', url: 'https://', alt: '' },
  products: { type: 'products', title: null, collectionSlug: 'featured' },
  cta: { type: 'cta', label: 'Shop now', href: '/' },
};

function PageEditor({ value, onChange }: { value: PageContent; onChange: (v: PageContent) => void }) {
  const [adding, setAdding] = useState<ContentBlock['type']>('text');
  const setBlock = (i: number, b: ContentBlock) =>
    onChange({ ...value, blocks: value.blocks.map((x, j) => (j === i ? b : x)) });
  const move = (i: number, d: -1 | 1) => {
    const blocks = [...value.blocks];
    const [b] = blocks.splice(i, 1);
    blocks.splice(i + d, 0, b!);
    onChange({ ...value, blocks });
  };
  return (
    <div className="uc-stack">
      <div className="uc-form-grid">
        <TextField
          label="Title"
          value={value.title}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
        />
        <TextField
          label="SEO title (optional)"
          value={value.seoTitle ?? ''}
          onChange={(e) => onChange({ ...value, seoTitle: e.target.value || null })}
          hint="Up to 70 characters"
        />
        <TextField
          label="SEO description (optional)"
          value={value.seoDescription ?? ''}
          onChange={(e) => onChange({ ...value, seoDescription: e.target.value || null })}
          hint="Up to 160 characters"
        />
      </div>
      {value.blocks.map((b, i) => (
        <fieldset key={i} className="uc-card" style={{ margin: 0 }}>
          <legend>
            Block {i + 1}: {b.type}
          </legend>
          {b.type === 'heading' && (
            <TextField
              label="Heading"
              value={b.text}
              onChange={(e) => setBlock(i, { ...b, text: e.target.value })}
            />
          )}
          {b.type === 'text' && (
            <label className="uc-field">
              <span className="uc-label">Text</span>
              <textarea
                className="uc-input"
                aria-label="Text"
                rows={4}
                value={b.text}
                onChange={(e) => setBlock(i, { ...b, text: e.target.value })}
              />
            </label>
          )}
          {b.type === 'image' && (
            <div className="uc-form-grid">
              <TextField
                label="Image URL"
                value={b.url}
                onChange={(e) => setBlock(i, { ...b, url: e.target.value })}
              />
              <TextField
                label="Alt text"
                value={b.alt}
                onChange={(e) => setBlock(i, { ...b, alt: e.target.value })}
              />
            </div>
          )}
          {b.type === 'products' && (
            <div className="uc-form-grid">
              <TextField
                label="Title (optional)"
                value={b.title ?? ''}
                onChange={(e) => setBlock(i, { ...b, title: e.target.value || null })}
              />
              <TextField
                label="Collection address"
                value={b.collectionSlug}
                onChange={(e) => setBlock(i, { ...b, collectionSlug: e.target.value })}
              />
            </div>
          )}
          {b.type === 'cta' && (
            <div className="uc-form-grid">
              <TextField
                label="Button label"
                value={b.label}
                onChange={(e) => setBlock(i, { ...b, label: e.target.value })}
              />
              <TextField
                label="Link"
                value={b.href}
                onChange={(e) => setBlock(i, { ...b, href: e.target.value })}
              />
            </div>
          )}
          <div className="uc-row">
            <Button size="sm" disabled={i === 0} onClick={() => move(i, -1)}>
              Move up
            </Button>
            <Button size="sm" disabled={i === value.blocks.length - 1} onClick={() => move(i, 1)}>
              Move down
            </Button>
            <Button
              size="sm"
              onClick={() => onChange({ ...value, blocks: value.blocks.filter((_, j) => j !== i) })}
            >
              Remove
            </Button>
          </div>
        </fieldset>
      ))}
      <div className="uc-row" style={{ alignItems: 'flex-end' }}>
        <SelectField
          label="Add a block"
          value={adding}
          onChange={(e) => setAdding(e.target.value as ContentBlock['type'])}
          options={[
            { value: 'heading', label: 'Heading' },
            { value: 'text', label: 'Text' },
            { value: 'image', label: 'Image' },
            { value: 'products', label: 'Products from a collection' },
            { value: 'cta', label: 'Button' },
          ]}
        />
        <Button onClick={() => onChange({ ...value, blocks: [...value.blocks, NEW_BLOCK[adding]] })}>
          Add block
        </Button>
      </div>
    </div>
  );
}

export default function DocumentPage() {
  const { documentId } = useParams<{ documentId: string }>();
  const { api, can, tenantId, context } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const tz = context.tenant.timezone;
  const enabled = can('content.manage') && context.features.includes('online_store');
  const doc = useTenantQuery<SiteDocument>(
    ['online-store', 'doc', documentId],
    `/v1/admin/online-store/documents/${documentId}`,
    undefined,
    enabled,
  );
  const [content, setContent] = useState<Content | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    if (doc.data) setContent(doc.data.draft);
  }, [doc.data]);
  const dirty = !!doc.data && !!content && JSON.stringify(content) !== JSON.stringify(doc.data.draft);
  useUnsavedChangesWarning(dirty);
  const done = (d: SiteDocument, msg: string) => {
    qc.setQueryData(['t', tenantId, 'online-store', 'doc', documentId, {}], d);
    void qc.invalidateQueries({ queryKey: ['t', tenantId, 'online-store', 'docs'] });
    toast(msg);
  };
  const save = useMutation({
    mutationFn: () =>
      api<SiteDocument>(`/v1/admin/online-store/documents/${documentId}/draft`, {
        method: 'PUT',
        body: { version: doc.data!.version, content },
      }),
    onSuccess: (d) => done(d, 'Draft saved'),
  });
  const publish = useMutation({
    mutationFn: (fromVersion: number | null) =>
      api<SiteDocument>(`/v1/admin/online-store/documents/${documentId}/publish`, {
        method: 'POST',
        body: { version: doc.data!.version, note: note.trim() || null, fromVersion },
      }),
    onSuccess: (d) => {
      setNote('');
      done(d, `Published version ${d.publishedVersion}`);
    },
  });
  const unpublish = useMutation({
    mutationFn: () =>
      api<SiteDocument>(`/v1/admin/online-store/documents/${documentId}/unpublish`, {
        method: 'POST',
        body: { version: doc.data!.version },
      }),
    onSuccess: (d) => done(d, 'Taken off the storefront'),
  });
  if (!enabled) return <ForbiddenState />;
  if (doc.error) return <ErrorState error={doc.error} onRetry={() => void doc.refetch()} />;
  if (!doc.data || !content) return <LoadingState />;
  const d = doc.data;
  const title =
    d.kind === 'page'
      ? `Page /pages/${d.key}`
      : d.kind === 'menu'
        ? `${d.key === 'header' ? 'Header' : 'Footer'} menu`
        : d.kind === 'theme'
          ? 'Theme'
          : 'Announcement banner';
  const error = save.error ?? publish.error ?? unpublish.error;
  return (
    <>
      <PageHeader
        title={title}
        description={
          d.live
            ? `Live: version ${d.publishedVersion}, published ${formatDateTime(d.publishedAt!, tz)}`
            : 'Not on the storefront'
        }
        actions={
          <>
            <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
              Save draft
            </Button>
            <Button
              variant="primary"
              disabled={dirty || (!d.hasChanges && d.live)}
              loading={publish.isPending}
              onClick={() => publish.mutate(null)}
            >
              Publish
            </Button>
            {d.live && (d.kind === 'page' || d.kind === 'banner') && (
              <Button variant="danger" loading={unpublish.isPending} onClick={() => unpublish.mutate()}>
                Unpublish
              </Button>
            )}
          </>
        }
      />
      <div className="uc-row">
        {d.hasChanges && <Badge tone="warning">Draft differs from what is live</Badge>}
        {dirty && <Badge tone="warning">Unsaved edits</Badge>}
      </div>
      {error && <Alert tone="danger">{errorMessage(error)}</Alert>}
      <Card title="Draft">
        {d.kind === 'theme' && (
          <ThemeEditor
            value={content as unknown as ThemeTokens}
            onChange={(v) => setContent(v as unknown as Content)}
          />
        )}
        {d.kind === 'menu' && (
          <MenuEditor
            value={content as unknown as MenuContent}
            onChange={(v) => setContent(v as unknown as Content)}
          />
        )}
        {d.kind === 'banner' && (
          <BannerEditor
            value={content as unknown as BannerContent}
            onChange={(v) => setContent(v as unknown as Content)}
          />
        )}
        {d.kind === 'page' && (
          <PageEditor
            value={content as unknown as PageContent}
            onChange={(v) => setContent(v as unknown as Content)}
          />
        )}
        <TextField label="Publish note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      </Card>
      <Card title="Published versions">
        <DataTable
          caption="Published versions"
          rows={d.versions}
          rowKey={(v) => String(v.version)}
          empty={<EmptyState title="Never published" />}
          columns={[
            {
              key: 'v',
              header: 'Version',
              render: (v) => (
                <>
                  v{v.version}{' '}
                  {v.version === d.publishedVersion && d.live && <Badge tone="success">live</Badge>}
                </>
              ),
            },
            { key: 'w', header: 'Published', render: (v) => formatDateTime(v.publishedAt, tz) },
            { key: 'b', header: 'By', render: (v) => v.publishedBy ?? '—' },
            { key: 'n', header: 'Note', render: (v) => v.note ?? '—' },
            {
              key: 'a',
              header: 'Actions',
              render: (v) =>
                v.version !== d.publishedVersion && (
                  <Button size="sm" disabled={dirty} onClick={() => publish.mutate(v.version)}>
                    Restore this version
                  </Button>
                ),
            },
          ]}
        />
        <span className="uc-hint">
          Restoring publishes the old content again as a new version; history is never rewritten.
        </span>
      </Card>
    </>
  );
}
