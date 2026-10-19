'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CreateCompanyRequest, type Company, type CompanySummary, type Page } from '@uc/contracts';
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
  useCursorPagination,
} from '@uc/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CompaniesTabs } from '../../../../lib/companies';
import { serverErrors, validate } from '../../../../lib/forms';
import { money } from '../../../../lib/pricing';
import { useTenant, useTenantQuery } from '../../../../lib/tenant';

function NewCompanyDialog({ onClose }: { onClose: () => void }) {
  const { api, tenantId } = useTenant();
  const qc = useQueryClient();
  const router = useRouter();
  const [form, setForm] = useState({ name: '', code: '', gstin: '', paymentTerms: 'on_account' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) => api<Company>('/v1/admin/companies', { method: 'POST', body }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'companies'] });
      router.push(`/t/${tenantId}/companies/${c.id}`);
    },
    onError: (e) => {
      const r = serverErrors(e);
      setErrors(r.fields);
      setMessage(r.message);
    },
  });
  function submit() {
    const body = {
      name: form.name,
      code: form.code.trim().toUpperCase(),
      gstin: form.gstin.trim() || null,
      paymentTerms: form.paymentTerms,
    };
    const check = validate(CreateCompanyRequest, body);
    if (!check.ok) return setErrors(check.errors);
    save.mutate(body);
  }
  return (
    <Dialog
      open
      title="New company"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            Create
          </Button>
        </>
      }
    >
      <div className="uc-form-grid">
        <TextField
          label="Company name"
          value={form.name}
          error={errors.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <TextField
          label="Code"
          value={form.code}
          error={errors.code}
          onChange={(e) => setForm({ ...form, code: e.target.value })}
          hint="e.g. SHREE"
        />
        <TextField
          label="GSTIN (optional)"
          value={form.gstin}
          error={errors.gstin}
          onChange={(e) => setForm({ ...form, gstin: e.target.value })}
          hint="Format is checked; validity is not verified"
        />
        <SelectField
          label="Payment terms"
          value={form.paymentTerms}
          onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })}
          options={[
            { value: 'on_account', label: 'On account (credit limit)' },
            { value: 'prepaid', label: 'Prepaid (advances only)' },
          ]}
        />
      </div>
      {message && <Alert tone="danger">{message}</Alert>}
    </Dialog>
  );
}

export default function CompaniesPage() {
  const { can, tenantId, context } = useTenant();
  const enabled = can('companies.read') && context.features.includes('b2b_companies');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const filters = { q: debounced, status };
  const pager = useCursorPagination(JSON.stringify(filters));
  const list = useTenantQuery<Page<CompanySummary>>(
    ['companies', 'list'],
    '/v1/admin/companies',
    { ...filters, cursor: pager.cursor, limit: 25 },
    enabled,
  );
  if (!enabled) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="Companies"
        description="Wholesale customers: their buyers, delivery locations, contract prices and credit."
        actions={
          can('companies.manage') && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New company
            </Button>
          )
        }
      />
      <CompaniesTabs />
      <Card>
        <div className="uc-filters" role="search">
          <TextField
            label="Search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name or code"
          />
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: '', label: 'Any' },
              { value: 'active', label: 'Active' },
              { value: 'on_hold', label: 'On hold' },
              { value: 'inactive', label: 'Inactive' },
            ]}
          />
        </div>
        <DataTable
          caption="Companies"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(c) => c.id}
          pagination={pager.controls(list.data?.nextCursor)}
          empty={
            <EmptyState
              title="No companies"
              description={
                can('companies.manage')
                  ? 'Create your first wholesale customer.'
                  : 'No companies are assigned to you.'
              }
            />
          }
          columns={[
            {
              key: 'name',
              header: 'Company',
              render: (c) => <Link href={`/t/${tenantId}/companies/${c.id}`}>{c.name}</Link>,
            },
            { key: 'code', header: 'Code', render: (c) => <span className="uc-mono">{c.code}</span> },
            {
              key: 'status',
              header: 'Status',
              render: (c) => (
                <Badge
                  tone={c.status === 'active' ? 'success' : c.status === 'on_hold' ? 'warning' : undefined}
                >
                  {c.status.replace('_', ' ')}
                </Badge>
              ),
            },
            {
              key: 'terms',
              header: 'Terms',
              render: (c) => (c.paymentTerms === 'prepaid' ? 'Prepaid' : 'On account'),
            },
            {
              key: 'exposure',
              header: 'Outstanding',
              render: (c) => (
                <span className="uc-mono">
                  {money(c.exposureMinor.replace('-', ''), c.currency)}
                  {c.exposureMinor.startsWith('-') ? ' credit' : ''}
                </span>
              ),
            },
            { key: 'buyers', header: 'Buyers', render: (c) => c.buyerCount },
            { key: 'rep', header: 'Sales rep', render: (c) => c.salesRep?.name ?? '—' },
          ]}
        />
      </Card>
      {creating && <NewCompanyDialog onClose={() => setCreating(false)} />}
    </>
  );
}
