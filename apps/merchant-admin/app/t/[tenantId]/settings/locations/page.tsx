'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CreateLocationRequest, UpdateLocationRequest, type Location, type Page } from '@uc/contracts';
import {
  Alert,
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
  useCursorPagination,
  useToast,
} from '@uc/ui';
import { useEffect, useState, type FormEvent } from 'react';
import { serverErrors, validate } from '../../../../../lib/forms';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

const TYPES = [
  { value: 'warehouse', label: 'Warehouse' },
  { value: 'branch', label: 'Branch' },
  { value: 'showroom', label: 'Showroom' },
  { value: 'bin', label: 'Bin' },
];

interface FormState {
  code: string;
  name: string;
  type: string;
  parentId: string;
  status: 'active' | 'inactive';
  line1: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
}

function LocationDialog({
  location,
  parents,
  onClose,
}: {
  location: Location | 'new';
  parents: Location[];
  onClose: () => void;
}) {
  const { api, tenantId, context } = useTenant();
  const toast = useToast();
  const queryClient = useQueryClient();
  const isNew = location === 'new';
  const existing = isNew ? null : location;
  const [form, setForm] = useState<FormState>({
    code: existing?.code ?? '',
    name: existing?.name ?? '',
    type: existing?.type ?? 'branch',
    parentId: existing?.parentId ?? '',
    status: existing?.status ?? 'active',
    line1: existing?.address?.line1 ?? '',
    city: existing?.address?.city ?? '',
    region: existing?.address?.region ?? '',
    postalCode: existing?.address?.postalCode ?? '',
    countryCode: existing?.address?.countryCode ?? context.tenant.countryCode,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) =>
      isNew
        ? api<Location>('/v1/admin/locations', { method: 'POST', body })
        : api<Location>(`/v1/admin/locations/${existing!.id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['t', tenantId, 'locations'] });
      toast(isNew ? 'Location created' : 'Location updated');
      onClose();
    },
    onError: (e) => {
      const r = serverErrors(e);
      setErrors(r.fields);
      setMessage(r.message);
    },
  });
  const set = (key: keyof FormState) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    const address =
      form.line1 || form.city
        ? {
            line1: form.line1,
            city: form.city,
            region: form.region || null,
            postalCode: form.postalCode || null,
            countryCode: form.countryCode,
          }
        : null;
    const body = isNew
      ? { code: form.code, name: form.name, type: form.type, parentId: form.parentId || null, address }
      : { version: existing!.version, name: form.name, status: form.status, address };
    const check = validate(isNew ? CreateLocationRequest : UpdateLocationRequest, body);
    if (!check.ok) return setErrors(check.errors);
    setErrors({});
    save.mutate(body);
  }
  return (
    <Dialog
      open
      title={isNew ? 'Add location' : `Edit ${existing!.name}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="location-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="location-form" className="uc-stack" onSubmit={submit} noValidate>
        <div className="uc-form-grid">
          {isNew && (
            <TextField
              label="Code"
              value={form.code}
              onChange={set('code')}
              error={errors.code}
              hint="Lower-case, unique, e.g. delhi-branch"
            />
          )}
          <TextField label="Name" value={form.name} onChange={set('name')} error={errors.name} />
          {isNew ? (
            <SelectField label="Type" value={form.type} onChange={set('type')} options={TYPES} />
          ) : (
            <SelectField
              label="Status"
              value={form.status}
              onChange={set('status')}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'inactive', label: 'Inactive' },
              ]}
              hint="Inactive locations stay in history but cannot be used for new stock (Phase 04)."
            />
          )}
          {isNew && (
            <SelectField
              label="Parent location"
              value={form.parentId}
              onChange={set('parentId')}
              error={errors.parentId}
              options={[
                { value: '', label: 'None' },
                ...parents
                  .filter((p) => p.type !== 'bin')
                  .map((p) => ({ value: p.id, label: `${p.name} (${p.type})` })),
              ]}
              hint="Bins must sit inside a warehouse, branch or showroom."
            />
          )}
        </div>
        <fieldset className="uc-fieldset">
          <legend>Address (optional)</legend>
          <div className="uc-form-grid">
            <TextField
              label="Address line"
              value={form.line1}
              onChange={set('line1')}
              error={errors['address.line1']}
            />
            <TextField label="City" value={form.city} onChange={set('city')} error={errors['address.city']} />
            <TextField label="Region / state" value={form.region} onChange={set('region')} />
            <TextField label="Postal code" value={form.postalCode} onChange={set('postalCode')} />
            <TextField
              label="Country (ISO-2)"
              value={form.countryCode}
              onChange={set('countryCode')}
              error={errors['address.countryCode']}
            />
          </div>
        </fieldset>
        {message && <Alert tone="danger">{message}</Alert>}
      </form>
    </Dialog>
  );
}

export default function LocationsPage() {
  const { can, context } = useTenant();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('code');
  const [editing, setEditing] = useState<Location | 'new' | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const filters = { q: debounced, type, status, sort };
  const pager = useCursorPagination(JSON.stringify(filters));
  const list = useTenantQuery<Page<Location>>(
    ['locations'],
    '/v1/admin/locations',
    { ...filters, cursor: pager.cursor, limit: 25 },
    can('locations.read'),
  );
  const parents = useTenantQuery<Page<Location>>(
    ['locations', 'parents'],
    '/v1/admin/locations',
    { status: 'active', limit: 100 },
    can('locations.manage'),
  );

  if (!can('locations.read')) return <ForbiddenState />;
  const scoped = context.membership.locationScope !== null;
  const canCreate = can('locations.manage') && !scoped;

  return (
    <>
      <PageHeader
        title="Locations"
        description="Branches, warehouses, showrooms and bins. Stock and reservations attach to these from Phase 04."
        actions={
          canCreate && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              Add location
            </Button>
          )
        }
      />
      {scoped && (
        <Alert tone="info">
          Your access is limited to {context.membership.locationScope!.length} assigned location(s); only
          those are listed.
        </Alert>
      )}
      <Card>
        <div className="uc-filters" role="search">
          <TextField
            label="Search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name or code"
          />
          <SelectField
            label="Type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            options={[{ value: '', label: 'All types' }, ...TYPES]}
          />
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: '', label: 'All' },
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Inactive' },
            ]}
          />
          <SelectField
            label="Sort"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            options={[
              { value: 'code', label: 'Code A→Z' },
              { value: '-code', label: 'Code Z→A' },
              { value: 'name', label: 'Name A→Z' },
              { value: '-createdAt', label: 'Newest first' },
              { value: 'createdAt', label: 'Oldest first' },
            ]}
          />
        </div>
        <DataTable
          caption="Locations"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(l) => l.id}
          pagination={pager.controls(list.data?.nextCursor)}
          empty={
            <EmptyState
              title={debounced || type || status ? 'No locations match these filters' : 'No locations yet'}
            />
          }
          columns={[
            { key: 'name', header: 'Name', render: (l) => l.name },
            { key: 'code', header: 'Code', render: (l) => <span className="uc-mono">{l.code}</span> },
            { key: 'type', header: 'Type', render: (l) => l.type },
            {
              key: 'city',
              header: 'City',
              render: (l) => l.address?.city ?? <span className="uc-muted">—</span>,
            },
            { key: 'status', header: 'Status', render: (l) => <StatusBadge status={l.status} /> },
            {
              key: 'actions',
              header: 'Actions',
              render: (l) =>
                can('locations.manage') ? (
                  <Button size="sm" onClick={() => setEditing(l)}>
                    Edit<span className="uc-sr-only"> {l.name}</span>
                  </Button>
                ) : null,
            },
          ]}
        />
      </Card>
      {editing && (
        <LocationDialog
          location={editing}
          parents={parents.data?.items ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
