'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { IMPORT_COLUMNS, MAX_IMPORT_ROWS, type ImportBatch, type Page } from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ForbiddenState,
  PageHeader,
  StatusBadge,
  errorMessage,
  formatDateTime,
  newIdempotencyKey,
  useCursorPagination,
  useToast,
} from '@uc/ui';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

const ACTION_LABEL: Record<string, string> = {
  create_product: 'New product',
  update_product: 'Update product',
  error: 'Error',
};

export default function ImportPage() {
  const { can, api, tenantId } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const pager = useCursorPagination('imports');
  const history = useTenantQuery<Page<Omit<ImportBatch, 'rows'>>>(
    ['imports'],
    '/v1/admin/catalog/imports',
    { cursor: pager.cursor, limit: 10 },
    can('catalog.edit'),
  );
  const refresh = () => void qc.invalidateQueries({ queryKey: ['t', tenantId, 'imports'] });

  const preview = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > 2_000_000)
        throw new Error('The file is larger than 2 MB. Split it into smaller files.');
      const content = await file.text();
      return api<ImportBatch>('/v1/admin/catalog/imports', {
        method: 'POST',
        body: { filename: file.name, content },
        idempotencyKey: newIdempotencyKey(),
      });
    },
    onSuccess: (b) => {
      setBatch(b);
      refresh();
    },
  });
  const commit = useMutation({
    mutationFn: (id: string) =>
      api<ImportBatch>(`/v1/admin/catalog/imports/${id}/commit`, { method: 'POST' }),
    onSuccess: (b) => {
      setBatch(b);
      refresh();
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'products'] });
      toast('Import applied');
    },
  });
  const discard = useMutation({
    mutationFn: (id: string) =>
      api<ImportBatch>(`/v1/admin/catalog/imports/${id}/discard`, { method: 'POST' }),
    onSuccess: (b) => {
      setBatch(b);
      refresh();
    },
  });
  const open = useMutation({
    mutationFn: (id: string) => api<ImportBatch>(`/v1/admin/catalog/imports/${id}`),
    onSuccess: setBatch,
  });

  if (!can('catalog.edit')) return <ForbiddenState />;
  const error = preview.error ?? commit.error ?? discard.error;

  return (
    <>
      <PageHeader
        title="Import products from CSV"
        description={<Link href={`/t/${tenantId}/products`}>Back to products</Link>}
        actions={
          <>
            <input
              ref={input}
              type="file"
              accept=".csv,text/csv"
              hidden
              aria-label="Choose CSV file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) preview.mutate(f);
                e.target.value = '';
              }}
            />
            <Button variant="primary" loading={preview.isPending} onClick={() => input.current?.click()}>
              Upload CSV for preview
            </Button>
          </>
        }
      />
      <Card title="File format">
        <p style={{ margin: 0 }}>
          One row per variant, grouped by <code>handle</code>. Required columns: <code>handle</code>,{' '}
          <code>sku</code>; a new product also needs <code>title</code>. Up to {MAX_IMPORT_ROWS} rows.
          Matching handles update products; matching SKUs update variants — nothing is duplicated. Preview
          writes nothing; if any row of a product fails, that product is skipped as a whole.
        </p>
        <p className="uc-mono" style={{ margin: 0 }}>
          {IMPORT_COLUMNS.join(',')}
        </p>
      </Card>
      {error && <Alert tone="danger">{errorMessage(error)}</Alert>}
      {batch && (
        <Card
          title={`${batch.filename}`}
          actions={
            <>
              <StatusBadge status={batch.status} />
              {batch.status === 'previewed' && (
                <>
                  <Button onClick={() => discard.mutate(batch.id)} loading={discard.isPending}>
                    Discard
                  </Button>
                  <Button
                    variant="primary"
                    disabled={batch.validCount === 0}
                    loading={commit.isPending}
                    onClick={() => commit.mutate(batch.id)}
                  >
                    Apply {batch.validCount} valid row(s)
                  </Button>
                </>
              )}
            </>
          }
        >
          <div className="uc-row">
            <Badge>{batch.rowCount} rows</Badge>
            <Badge tone="success">{batch.validCount} valid</Badge>
            <Badge tone={batch.errorCount ? 'danger' : undefined}>{batch.errorCount} with errors</Badge>
          </div>
          {batch.summary && (
            <Alert tone="success" title="Applied">
              {batch.summary.productsCreated} products created, {batch.summary.productsUpdated} updated;{' '}
              {batch.summary.variantsCreated} variants created, {batch.summary.variantsUpdated} updated.
            </Alert>
          )}
          <DataTable
            caption="Import rows"
            rows={batch.rows}
            rowKey={(r) => String(r.line)}
            empty={<EmptyState title="No rows" />}
            columns={[
              { key: 'line', header: 'Line', render: (r) => r.line },
              { key: 'handle', header: 'Handle', render: (r) => <span className="uc-mono">{r.handle}</span> },
              { key: 'sku', header: 'SKU', render: (r) => <span className="uc-mono">{r.sku}</span> },
              {
                key: 'action',
                header: 'Result',
                render: (r) => (
                  <Badge tone={r.action === 'error' ? 'danger' : 'success'}>
                    {ACTION_LABEL[r.action]}
                    {r.action !== 'error' ? ` · variant ${r.variantAction}` : ''}
                  </Badge>
                ),
              },
              {
                key: 'errors',
                header: 'Problems',
                render: (r) =>
                  r.errors.length ? (
                    <ul style={{ margin: 0, paddingLeft: 16 }}>
                      {r.errors.map((e, i) => (
                        <li key={i}>
                          <strong>{e.field}</strong>: {e.message}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
        </Card>
      )}
      <Card title="Recent imports">
        <DataTable
          caption="Recent imports"
          rows={history.data?.items}
          isLoading={history.isLoading}
          error={history.error}
          rowKey={(b) => b.id}
          pagination={pager.controls(history.data?.nextCursor)}
          empty={<EmptyState title="No imports yet" />}
          columns={[
            {
              key: 'file',
              header: 'File',
              render: (b) => (
                <Button size="sm" variant="ghost" onClick={() => open.mutate(b.id)}>
                  {b.filename}
                </Button>
              ),
            },
            { key: 'status', header: 'Status', render: (b) => <StatusBadge status={b.status} /> },
            { key: 'rows', header: 'Rows', render: (b) => `${b.validCount}/${b.rowCount} valid` },
            { key: 'created', header: 'Uploaded', render: (b) => formatDateTime(b.createdAt) },
          ]}
        />
      </Card>
    </>
  );
}
