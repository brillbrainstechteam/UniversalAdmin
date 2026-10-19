'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  currencyMinorUnits,
  formatMinor,
  type Collection,
  type Company,
  type CompanyBuyer,
  type CreditEntry,
  type Member,
  type Page,
  type PriceBook,
} from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  SelectField,
  TextField,
  errorMessage,
  formatDateTime,
  useCursorPagination,
  useToast,
} from '@uc/ui';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { CompaniesTabs, toMinorText } from '../../../../../lib/companies';
import { serverErrors } from '../../../../../lib/forms';
import { money } from '../../../../../lib/pricing';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

const ROLE_LABELS = { buyer: 'Buyer', approver: 'Approver', admin: 'Company admin' } as const;

function useRefresh() {
  const { tenantId } = useTenant();
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ['t', tenantId, 'companies'] });
}

function Profile({ c, mu }: { c: Company; mu: number }) {
  const { api, can } = useTenant();
  const toast = useToast();
  const refresh = useRefresh();
  const edit = can('companies.manage');
  const staff = useTenantQuery<Page<Member>>(
    ['members', 'all'],
    '/v1/admin/members',
    { limit: 100 },
    edit && can('staff.read'),
  );
  const books = useTenantQuery<{ items: PriceBook[] }>(
    ['pricing', 'books'],
    '/v1/admin/pricing/books',
    undefined,
    edit && can('pricing.read'),
  );
  const cols = useTenantQuery<Page<Collection>>(
    ['collections', 'all'],
    '/v1/admin/collections',
    { limit: 100 },
    edit && can('catalog.read'),
  );
  const [f, setF] = useState(() => ({
    status: c.status,
    paymentTerms: c.paymentTerms,
    creditLimit: c.creditLimitMinor === null ? '' : formatMinor(c.creditLimitMinor, mu),
    minOrder: c.minOrderMinor === null ? '' : formatMinor(c.minOrderMinor, mu),
    accountingAuthority: c.accountingAuthority,
    salesRepUserId: c.salesRep?.id ?? '',
    priceBookId: c.priceBook?.id ?? '',
    catalogMode: c.catalogMode,
    collectionIds: c.collectionIds,
    gstin: c.gstin ?? '',
    notes: c.notes ?? '',
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => {
      const creditLimitMinor = toMinorText(f.creditLimit, mu);
      const minOrderMinor = toMinorText(f.minOrder, mu);
      if (creditLimitMinor === 'invalid' || minOrderMinor === 'invalid')
        throw new Error('Enter amounts like 500000.00');
      return api(`/v1/admin/companies/${c.id}`, {
        method: 'PATCH',
        body: {
          version: c.version,
          status: f.status,
          paymentTerms: f.paymentTerms,
          creditLimitMinor,
          minOrderMinor,
          accountingAuthority: f.accountingAuthority,
          salesRepUserId: f.salesRepUserId || null,
          priceBookId: f.priceBookId || null,
          catalogMode: f.catalogMode,
          collectionIds: f.catalogMode === 'collections' ? f.collectionIds : [],
          gstin: f.gstin.trim() || null,
          notes: f.notes.trim() || null,
        },
      });
    },
    onSuccess: () => {
      refresh();
      setErrors({});
      toast('Company saved');
    },
    onError: (e) => setErrors(serverErrors(e).fields),
  });
  return (
    <Card
      title="Terms"
      actions={
        edit && (
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        )
      }
    >
      <fieldset disabled={!edit} style={{ border: 0, padding: 0 }}>
        <div className="uc-form-grid">
          <SelectField
            label="Status"
            value={f.status}
            onChange={(e) => setF({ ...f, status: e.target.value as Company['status'] })}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'on_hold', label: 'On hold (no new orders)' },
              { value: 'inactive', label: 'Inactive (buyers cannot sign in)' },
            ]}
          />
          <SelectField
            label="Payment terms"
            value={f.paymentTerms}
            onChange={(e) => setF({ ...f, paymentTerms: e.target.value as Company['paymentTerms'] })}
            options={[
              { value: 'on_account', label: 'On account' },
              { value: 'prepaid', label: 'Prepaid (advances only)' },
            ]}
          />
          <TextField
            label={`Credit limit (${c.credit.currency})`}
            inputMode="decimal"
            value={f.creditLimit}
            error={errors.creditLimitMinor}
            onChange={(e) => setF({ ...f, creditLimit: e.target.value })}
            hint="Empty = no limit (on account)"
          />
          <TextField
            label={`Minimum order value (${c.credit.currency})`}
            inputMode="decimal"
            value={f.minOrder}
            error={errors.minOrderMinor}
            onChange={(e) => setF({ ...f, minOrder: e.target.value })}
          />
          <SelectField
            label="Accounting authority"
            value={f.accountingAuthority}
            onChange={(e) =>
              setF({ ...f, accountingAuthority: e.target.value as Company['accountingAuthority'] })
            }
            options={[
              { value: 'commerce', label: 'This platform (credit ledger here)' },
              { value: 'erp', label: 'ERP (outstanding not synced yet)' },
            ]}
          />
          <SelectField
            label="Sales rep"
            value={f.salesRepUserId}
            onChange={(e) => setF({ ...f, salesRepUserId: e.target.value })}
            options={[
              { value: '', label: 'None' },
              ...(c.salesRep && !staff.data?.items.some((m) => m.user.id === c.salesRep!.id)
                ? [{ value: c.salesRep.id, label: c.salesRep.name }]
                : []),
              ...(staff.data?.items ?? [])
                .filter((m) => m.status === 'active')
                .map((m) => ({ value: m.user.id, label: m.user.displayName })),
            ]}
          />
          <SelectField
            label="Contract price book"
            value={f.priceBookId}
            onChange={(e) => setF({ ...f, priceBookId: e.target.value })}
            options={[
              { value: '', label: 'Standard prices' },
              ...(c.priceBook && !books.data?.items.some((b) => b.id === c.priceBook!.id)
                ? [{ value: c.priceBook.id, label: c.priceBook.name }]
                : []),
              ...(books.data?.items ?? []).map((b) => ({ value: b.id, label: b.name })),
            ]}
            hint="A company book is used only for this company and wins over all other books"
          />
          <TextField
            label="GSTIN"
            value={f.gstin}
            error={errors.gstin}
            onChange={(e) => setF({ ...f, gstin: e.target.value })}
            hint="Format checked only"
          />
          <SelectField
            label="Catalog"
            value={f.catalogMode}
            onChange={(e) => setF({ ...f, catalogMode: e.target.value as Company['catalogMode'] })}
            options={[
              { value: 'all', label: 'Everything published on the portal' },
              { value: 'collections', label: 'Only chosen collections' },
            ]}
          />
        </div>
        {f.catalogMode === 'collections' && (
          <div className="uc-row" style={{ flexWrap: 'wrap' }} role="group" aria-label="Collections">
            {(cols.data?.items ?? []).map((col) => (
              <Checkbox
                key={col.id}
                label={col.title}
                checked={f.collectionIds.includes(col.id)}
                onChange={(e) =>
                  setF({
                    ...f,
                    collectionIds: e.target.checked
                      ? [...f.collectionIds, col.id]
                      : f.collectionIds.filter((x) => x !== col.id),
                  })
                }
              />
            ))}
          </div>
        )}
        <TextField label="Notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </fieldset>
      {save.error && Object.keys(errors).length === 0 && (
        <Alert tone="danger">{errorMessage(save.error)}</Alert>
      )}
    </Card>
  );
}

function Credit({ c, mu }: { c: Company; mu: number }) {
  const { api, can, context } = useTenant();
  const toast = useToast();
  const refresh = useRefresh();
  const pager = useCursorPagination(c.id);
  const ledger = useTenantQuery<Page<CreditEntry>>(
    ['companies', 'credit', c.id],
    `/v1/admin/companies/${c.id}/credit`,
    { cursor: pager.cursor, limit: 20 },
  );
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ type: 'payment', amount: '', reference: '', note: '' });
  const [message, setMessage] = useState<string | null>(null);
  const record = useMutation({
    mutationFn: () => {
      const neg = form.type === 'adjustment' && form.amount.trim().startsWith('-');
      const minor = toMinorText(form.amount.replace('-', ''), mu);
      if (!minor || minor === 'invalid') throw new Error('Enter an amount like 25000.00');
      return api(`/v1/admin/companies/${c.id}/credit`, {
        method: 'POST',
        body: {
          type: form.type,
          amountMinor: neg ? `-${minor}` : minor,
          reference: form.reference,
          note: form.note,
        },
      });
    },
    onSuccess: () => {
      refresh();
      setOpen(false);
      toast('Recorded in the credit ledger');
    },
    onError: (e) => setMessage(serverErrors(e).message ?? errorMessage(e)),
  });
  const m = (v: string) =>
    `${v.startsWith('-') ? '−' : ''}${money(v.replace('-', ''), c.credit.currency, mu)}`;
  return (
    <Card
      title="Credit"
      actions={
        can('companies.manage') && <Button onClick={() => setOpen(true)}>Record payment / advance</Button>
      }
    >
      <dl className="uc-row" style={{ flexWrap: 'wrap', gap: 24 }}>
        <div>
          <dt className="uc-muted">Limit</dt>
          <dd className="uc-mono">{c.credit.limitMinor === null ? 'No limit' : m(c.credit.limitMinor)}</dd>
        </div>
        <div>
          <dt className="uc-muted">Exposure (open orders − payments)</dt>
          <dd className="uc-mono">{m(c.credit.exposureMinor)}</dd>
        </div>
        <div>
          <dt className="uc-muted">Available</dt>
          <dd className="uc-mono">{c.credit.availableMinor === null ? '—' : m(c.credit.availableMinor)}</dd>
        </div>
      </dl>
      {c.accountingAuthority === 'erp' && (
        <Alert tone="warning">
          The ERP is the accounting authority, but no ERP outstanding is synced yet: figures here are from
          this platform only.
        </Alert>
      )}
      <DataTable
        caption="Credit ledger"
        rows={ledger.data?.items}
        isLoading={ledger.isLoading}
        error={ledger.error}
        rowKey={(e) => e.id}
        pagination={pager.controls(ledger.data?.nextCursor)}
        empty={<EmptyState title="No ledger entries" />}
        columns={[
          {
            key: 'when',
            header: 'When',
            render: (e) => formatDateTime(e.createdAt, context.tenant.timezone),
          },
          { key: 'type', header: 'Type', render: (e) => e.type.replace('_', ' ') },
          {
            key: 'amount',
            header: 'Amount',
            render: (e) => <span className="uc-mono">{m(e.amountMinor)}</span>,
          },
          {
            key: 'ref',
            header: 'Reference',
            render: (e) => <span className="uc-mono">{e.reference ?? '—'}</span>,
          },
          { key: 'note', header: 'Note', render: (e) => e.note ?? '' },
          { key: 'by', header: 'By', render: (e) => e.actor?.name ?? 'System' },
        ]}
      />
      <Dialog
        open={open}
        title="Record in the credit ledger"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={record.isPending} onClick={() => record.mutate()}>
              Record
            </Button>
          </>
        }
      >
        <div className="uc-form-grid">
          <SelectField
            label="Type"
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value })}
            options={[
              { value: 'payment', label: 'Payment received' },
              { value: 'advance', label: 'Advance received' },
              { value: 'adjustment', label: 'Adjustment (− lowers what they owe)' },
            ]}
          />
          <TextField
            label={`Amount (${c.credit.currency})`}
            inputMode="decimal"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
          />
          <TextField
            label="Reference"
            value={form.reference}
            onChange={(e) => setForm({ ...form, reference: e.target.value })}
            hint="Bank / receipt number"
          />
          <TextField
            label="Note"
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </div>
        <span className="uc-muted">
          Ledger entries can never be edited or deleted; correct a mistake with an adjustment.
        </span>
        {message && <Alert tone="danger">{message}</Alert>}
      </Dialog>
    </Card>
  );
}

function Locations({ c }: { c: Company }) {
  const { api, can } = useTenant();
  const toast = useToast();
  const refresh = useRefresh();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', code: '', line1: '', city: '', countryCode: 'IN' });
  const [message, setMessage] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () =>
      api(`/v1/admin/companies/${c.id}/locations`, {
        method: 'POST',
        body: {
          name: form.name,
          code: form.code.trim().toLowerCase(),
          address: { line1: form.line1, city: form.city, countryCode: form.countryCode.toUpperCase() },
        },
      }),
    onSuccess: () => {
      refresh();
      setOpen(false);
      toast('Location added');
    },
    onError: (e) => setMessage(serverErrors(e).message ?? 'Check the highlighted fields'),
  });
  return (
    <Card
      title="Locations"
      actions={can('companies.manage') && <Button onClick={() => setOpen(true)}>Add location</Button>}
    >
      <DataTable
        caption="Company locations"
        rows={c.locations}
        rowKey={(l) => l.id}
        empty={
          <EmptyState
            title="No locations"
            description="Buyers need at least one delivery location to order."
          />
        }
        columns={[
          { key: 'name', header: 'Name', render: (l) => l.name },
          { key: 'code', header: 'Code', render: (l) => <span className="uc-mono">{l.code}</span> },
          {
            key: 'addr',
            header: 'Address',
            render: (l) => `${l.address.line1}, ${l.address.city} ${l.address.countryCode}`,
          },
          {
            key: 'status',
            header: 'Status',
            render: (l) => <Badge tone={l.status === 'active' ? 'success' : undefined}>{l.status}</Badge>,
          },
        ]}
      />
      <Dialog
        open={open}
        title="Add location"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={add.isPending} onClick={() => add.mutate()}>
              Add
            </Button>
          </>
        }
      >
        <div className="uc-form-grid">
          <TextField
            label="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <TextField
            label="Code"
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
            hint="e.g. pune-store"
          />
          <TextField
            label="Address line"
            value={form.line1}
            onChange={(e) => setForm({ ...form, line1: e.target.value })}
          />
          <TextField
            label="City"
            value={form.city}
            onChange={(e) => setForm({ ...form, city: e.target.value })}
          />
          <TextField
            label="Country code"
            value={form.countryCode}
            onChange={(e) => setForm({ ...form, countryCode: e.target.value })}
          />
        </div>
        {message && <Alert tone="danger">{message}</Alert>}
      </Dialog>
    </Card>
  );
}

function Buyers({ c, mu }: { c: Company; mu: number }) {
  const { api, can } = useTenant();
  const toast = useToast();
  const refresh = useRefresh();
  const edit = can('companies.manage');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ email: '', role: 'buyer', limit: '', locationIds: [] as string[] });
  const [link, setLink] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: () => {
      const limit = toMinorText(form.limit, mu);
      if (limit === 'invalid') throw new Error('Enter the order limit like 100000.00');
      return api<{ invitationPath: string }>(`/v1/admin/companies/${c.id}/buyers`, {
        method: 'POST',
        body: {
          email: form.email,
          role: form.role,
          orderLimitMinor: limit,
          locationIds: form.locationIds.length ? form.locationIds : null,
        },
      });
    },
    onSuccess: (r) => {
      refresh();
      setLink(r.invitationPath);
    },
    onError: (e) => setMessage(serverErrors(e).message ?? errorMessage(e)),
  });
  const toggle = useMutation({
    mutationFn: (b: CompanyBuyer) =>
      api(`/v1/admin/companies/${c.id}/buyers/${b.id}`, {
        method: 'PATCH',
        body: { version: b.version, status: b.status === 'active' ? 'disabled' : 'active' },
      }),
    onSuccess: () => {
      refresh();
      toast('Buyer updated');
    },
  });
  const locName = (id: string) => c.locations.find((l) => l.id === id)?.name ?? 'Unknown';
  return (
    <Card
      title="Buyers"
      actions={
        edit && (
          <Button
            onClick={() => {
              setOpen(true);
              setLink(null);
              setMessage(null);
            }}
          >
            Invite buyer
          </Button>
        )
      }
    >
      <DataTable
        caption="Company buyers"
        rows={c.buyers}
        rowKey={(b) => b.id}
        empty={<EmptyState title="No buyers" description="Invite the people who order for this company." />}
        columns={[
          {
            key: 'who',
            header: 'Buyer',
            render: (b) => (b.user ? `${b.user.displayName} · ${b.email}` : b.email),
          },
          { key: 'role', header: 'Role', render: (b) => ROLE_LABELS[b.role] },
          {
            key: 'locs',
            header: 'Locations',
            render: (b) => (b.locationIds ? b.locationIds.map(locName).join(', ') : 'All'),
          },
          {
            key: 'limit',
            header: 'Order limit',
            render: (b) =>
              b.orderLimitMinor === null ? 'None' : money(b.orderLimitMinor, c.credit.currency, mu),
          },
          {
            key: 'status',
            header: 'Status',
            render: (b) => (
              <Badge tone={b.status === 'active' ? 'success' : b.status === 'invited' ? 'info' : undefined}>
                {b.status}
              </Badge>
            ),
          },
          {
            key: 'act',
            header: 'Actions',
            render: (b) =>
              edit && b.status !== 'invited' ? (
                <Button size="sm" onClick={() => toggle.mutate(b)}>
                  {b.status === 'active' ? 'Disable' : 'Enable'}
                  <span className="uc-sr-only"> {b.email}</span>
                </Button>
              ) : null,
          },
        ]}
      />
      <Dialog
        open={open}
        title="Invite buyer"
        onClose={() => setOpen(false)}
        footer={
          link ? (
            <Button onClick={() => setOpen(false)}>Done</Button>
          ) : (
            <>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" loading={invite.isPending} onClick={() => invite.mutate()}>
                Create invitation
              </Button>
            </>
          )
        }
      >
        {link ? (
          <Alert tone="success" title="Invitation link (shown once)">
            Send this link to the buyer through your own channel. It opens on your B2B portal domain and
            expires in 7 days:
            <div className="uc-mono" style={{ wordBreak: 'break-all' }}>
              {link}
            </div>
          </Alert>
        ) : (
          <>
            <div className="uc-form-grid">
              <TextField
                label="Email"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
              <SelectField
                label="Role"
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                options={Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }))}
              />
              <TextField
                label={`Order limit (${c.credit.currency}, optional)`}
                inputMode="decimal"
                value={form.limit}
                onChange={(e) => setForm({ ...form, limit: e.target.value })}
                hint="Larger orders need a company approver"
              />
            </div>
            <div
              className="uc-row"
              style={{ flexWrap: 'wrap' }}
              role="group"
              aria-label="Locations (none = all)"
            >
              {c.locations.map((l) => (
                <Checkbox
                  key={l.id}
                  label={l.name}
                  checked={form.locationIds.includes(l.id)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      locationIds: e.target.checked
                        ? [...form.locationIds, l.id]
                        : form.locationIds.filter((x) => x !== l.id),
                    })
                  }
                />
              ))}
            </div>
            {message && <Alert tone="danger">{message}</Alert>}
          </>
        )}
      </Dialog>
    </Card>
  );
}

export default function CompanyPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const { can, context } = useTenant();
  const enabled = can('companies.read') && context.features.includes('b2b_companies');
  const company = useTenantQuery<Company>(
    ['companies', 'company', companyId],
    `/v1/admin/companies/${companyId}`,
    undefined,
    enabled,
  );
  if (!enabled) return <ForbiddenState />;
  if (company.error) return <ErrorState error={company.error} onRetry={() => void company.refetch()} />;
  if (!company.data) return <LoadingState />;
  const c = company.data;
  const mu = currencyMinorUnits(c.credit.currency);
  return (
    <>
      <PageHeader
        title={c.name}
        description={`${c.code}${c.gstin ? ` · GSTIN ${c.gstin} (format checked, not verified)` : ''}`}
      />
      <CompaniesTabs />
      {c.status !== 'active' && (
        <Alert tone="warning">
          This company is {c.status.replace('_', ' ')}: its buyers cannot place orders.
        </Alert>
      )}
      {/* Remounts with fresh values whenever the company is saved (version changes). */}
      <Profile key={c.version} c={c} mu={mu} />
      <Credit c={c} mu={mu} />
      <Locations c={c} />
      <Buyers c={c} mu={mu} />
    </>
  );
}
