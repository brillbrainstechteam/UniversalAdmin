'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CHANNEL_TYPES,
  CreateChannelRequest,
  CreateStoreRequest,
  type Channel,
  type ChannelType,
  type Page,
  type Store,
} from '@uc/contracts';
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
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { serverErrors, validate } from '../../../../../lib/forms';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

function StoreDialog({ store, onClose }: { store: Store | 'new' | null; onClose: () => void }) {
  const { api, tenantId, context } = useTenant();
  const toast = useToast();
  const queryClient = useQueryClient();
  const isNew = store === 'new';
  const [code, setCode] = useState('');
  const [name, setName] = useState(store && store !== 'new' ? store.name : '');
  const [status, setStatus] = useState(store && store !== 'new' ? store.status : 'active');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) =>
      isNew
        ? api<Store>('/v1/admin/stores', { method: 'POST', body })
        : api<Store>(`/v1/admin/stores/${(store as Store).id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['t', tenantId, 'stores'] });
      toast(isNew ? 'Store created' : 'Store updated');
      onClose();
    },
    onError: (e) => {
      const r = serverErrors(e);
      setErrors(r.fields);
      setMessage(r.message);
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    if (isNew) {
      const body = { code, name };
      const check = validate(CreateStoreRequest, body);
      if (!check.ok) return setErrors(check.errors);
      save.mutate(body);
    } else if (store) {
      save.mutate({ version: store.version, name, status });
    }
  }
  return (
    <Dialog
      open={store !== null}
      title={isNew ? 'Add store' : 'Edit store'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="store-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="store-form" className="uc-stack" onSubmit={submit} noValidate>
        {isNew && (
          <TextField
            label="Code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            error={errors.code}
            hint="Lower-case, e.g. mumbai-retail. Cannot be changed later."
          />
        )}
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
        {!isNew && (
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as 'active' | 'inactive')}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Inactive' },
            ]}
          />
        )}
        {isNew && (
          <span className="uc-muted">
            Currency {context.tenant.defaultCurrency} and time zone {context.tenant.timezone} are inherited
            from business settings.
          </span>
        )}
        {message && <Alert tone="danger">{message}</Alert>}
      </form>
    </Dialog>
  );
}

function ChannelDialog({ open, stores, onClose }: { open: boolean; stores: Store[]; onClose: () => void }) {
  const { api, tenantId, context } = useTenant();
  const toast = useToast();
  const queryClient = useQueryClient();
  const entitledTypes = (Object.keys(CHANNEL_TYPES) as ChannelType[]).filter((t) =>
    context.features.includes(CHANNEL_TYPES[t].feature),
  );
  const [form, setForm] = useState({
    storeId: stores[0]?.id ?? '',
    code: '',
    name: '',
    type: entitledTypes[0] ?? 'api',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) => api<Channel>('/v1/admin/channels', { method: 'POST', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['t', tenantId, 'channels'] });
      toast('Channel created');
      onClose();
    },
    onError: (e) => {
      const r = serverErrors(e);
      setErrors(r.fields);
      setMessage(r.message);
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    const check = validate(CreateChannelRequest, form);
    if (!check.ok) return setErrors(check.errors);
    save.mutate(form);
  }
  return (
    <Dialog
      open={open}
      title="Add channel"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="channel-form" loading={save.isPending}>
            Create
          </Button>
        </>
      }
    >
      <form id="channel-form" className="uc-stack" onSubmit={submit} noValidate>
        <SelectField
          label="Store"
          value={form.storeId}
          onChange={(e) => setForm({ ...form, storeId: e.target.value })}
          options={stores.map((s) => ({ value: s.id, label: `${s.name} (${s.code})` }))}
          error={errors.storeId}
        />
        <SelectField
          label="Type"
          value={form.type}
          onChange={(e) => setForm({ ...form, type: e.target.value as ChannelType })}
          options={entitledTypes.map((t) => ({ value: t, label: CHANNEL_TYPES[t].label }))}
          hint="Only channel types entitled for this merchant are listed."
        />
        <TextField
          label="Code"
          value={form.code}
          onChange={(e) => setForm({ ...form, code: e.target.value })}
          error={errors.code}
          hint="Lower-case, e.g. exhibition-2026"
        />
        <TextField
          label="Name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          error={errors.name}
        />
        {message && <Alert tone="danger">{message}</Alert>}
      </form>
    </Dialog>
  );
}

export default function StoresPage() {
  const { can, tenantId } = useTenant();
  const storePager = useCursorPagination('stores');
  const channelPager = useCursorPagination('channels');
  const stores = useTenantQuery<Page<Store>>(
    ['stores'],
    '/v1/admin/stores',
    { cursor: storePager.cursor, limit: 25 },
    can('stores.read'),
  );
  const allStores = useTenantQuery<Page<Store>>(
    ['stores', 'all'],
    '/v1/admin/stores',
    { limit: 100, status: 'active' },
    can('stores.manage'),
  );
  const channels = useTenantQuery<Page<Channel>>(
    ['channels'],
    '/v1/admin/channels',
    { cursor: channelPager.cursor, limit: 25 },
    can('stores.read'),
  );
  const [editing, setEditing] = useState<Store | 'new' | null>(null);
  const [addingChannel, setAddingChannel] = useState(false);

  if (!can('stores.read')) return <ForbiddenState />;
  const manage = can('stores.manage');

  return (
    <>
      <PageHeader
        title="Stores & channels"
        description="Stores group sales channels; each channel has its own brand theme and (from Phase 10) domains."
      />
      <Card
        title="Stores"
        actions={
          manage && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              Add store
            </Button>
          )
        }
      >
        <DataTable
          caption="Stores"
          rows={stores.data?.items}
          isLoading={stores.isLoading}
          error={stores.error}
          onRetry={() => void stores.refetch()}
          rowKey={(s) => s.id}
          empty={<EmptyState title="No stores" description="Add a store to start configuring channels." />}
          pagination={storePager.controls(stores.data?.nextCursor)}
          columns={[
            { key: 'name', header: 'Name', render: (s) => s.name },
            { key: 'code', header: 'Code', render: (s) => <span className="uc-mono">{s.code}</span> },
            { key: 'currency', header: 'Currency', render: (s) => s.defaultCurrency },
            { key: 'tz', header: 'Time zone', render: (s) => s.timezone },
            { key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.status} /> },
            {
              key: 'actions',
              header: 'Actions',
              render: (s) =>
                manage ? (
                  <Button size="sm" onClick={() => setEditing(s)}>
                    Edit<span className="uc-sr-only"> {s.name}</span>
                  </Button>
                ) : null,
            },
          ]}
        />
      </Card>
      <Card
        title="Channels"
        actions={
          manage && (
            <Button
              variant="primary"
              onClick={() => setAddingChannel(true)}
              disabled={!allStores.data?.items.length}
            >
              Add channel
            </Button>
          )
        }
      >
        <DataTable
          caption="Channels"
          rows={channels.data?.items}
          isLoading={channels.isLoading}
          error={channels.error}
          onRetry={() => void channels.refetch()}
          rowKey={(c) => c.id}
          empty={
            <EmptyState
              title="No channels"
              description="Channels are where you sell: storefronts, POS, marketplaces."
            />
          }
          pagination={channelPager.controls(channels.data?.nextCursor)}
          columns={[
            {
              key: 'name',
              header: 'Name',
              render: (c) => <Link href={`/t/${tenantId}/settings/stores/channels/${c.id}`}>{c.name}</Link>,
            },
            { key: 'type', header: 'Type', render: (c) => CHANNEL_TYPES[c.type].label },
            { key: 'code', header: 'Code', render: (c) => <span className="uc-mono">{c.code}</span> },
            {
              key: 'domains',
              header: 'Domains',
              render: (c) =>
                c.domains.length ? (
                  <span className="uc-stack" style={{ gap: 2 }}>
                    {c.domains.map((d) => (
                      <span key={d.hostname} className="uc-row">
                        <span className="uc-mono">{d.hostname}</span>
                        <StatusBadge status={d.status} />
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="uc-muted">None</span>
                ),
            },
            { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
          ]}
        />
      </Card>
      {editing && <StoreDialog store={editing} onClose={() => setEditing(null)} />}
      {addingChannel && allStores.data && (
        <ChannelDialog open stores={allStores.data.items} onClose={() => setAddingChannel(false)} />
      )}
    </>
  );
}
