'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CreateInvitationRequest,
  type CreateInvitationResponse,
  type Invitation,
  type Location,
  type Member,
  type Page,
  type Role,
} from '@uc/contracts';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
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
  newIdempotencyKey,
  useCursorPagination,
  useToast,
} from '@uc/ui';
import { useEffect, useState, type FormEvent } from 'react';
import { serverErrors, validate } from '../../../../../lib/forms';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

function RolePicker({
  roles,
  selected,
  onChange,
}: {
  roles: Role[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="uc-fieldset">
      <legend>Roles</legend>
      <div className="uc-stack" style={{ gap: 6 }}>
        {roles.map((r) => (
          <Checkbox
            key={r.id}
            label={r.name}
            description={r.description}
            checked={selected.includes(r.id)}
            onChange={(e) =>
              onChange(e.target.checked ? [...selected, r.id] : selected.filter((x) => x !== r.id))
            }
          />
        ))}
      </div>
    </fieldset>
  );
}

function ScopePicker({
  locations,
  value,
  onChange,
}: {
  locations: Location[];
  value: string[] | null;
  onChange: (v: string[] | null) => void;
}) {
  return (
    <fieldset className="uc-fieldset">
      <legend>Location access</legend>
      <Checkbox
        label="All locations"
        checked={value === null}
        onChange={(e) => onChange(e.target.checked ? null : [])}
      />
      {value !== null && (
        <div className="uc-stack" style={{ gap: 6, marginTop: 8 }}>
          {locations.length === 0 && <span className="uc-muted">No locations available.</span>}
          {locations.map((l) => (
            <Checkbox
              key={l.id}
              label={`${l.name} (${l.code})`}
              checked={value.includes(l.id)}
              onChange={(e) =>
                onChange(e.target.checked ? [...value, l.id] : value.filter((x) => x !== l.id))
              }
            />
          ))}
        </div>
      )}
    </fieldset>
  );
}

function MemberDialog({
  member,
  roles,
  locations,
  onClose,
}: {
  member: Member;
  roles: Role[];
  locations: Location[];
  onClose: () => void;
}) {
  const { api, tenantId } = useTenant();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [roleIds, setRoleIds] = useState(member.roles.map((r) => r.id));
  const [status, setStatus] = useState(member.status);
  const [scope, setScope] = useState<string[] | null>(member.locationScope);
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api<Member>(`/v1/admin/members/${member.id}`, {
        method: 'PATCH',
        body: { version: member.version, roleIds, status, locationScope: scope },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['t', tenantId, 'members'] });
      toast('Staff member updated');
      onClose();
    },
    onError: (e) => setMessage(errorMessage(e)),
  });
  return (
    <Dialog
      open
      title={`Edit ${member.user.displayName}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={roleIds.length === 0 || (scope !== null && scope.length === 0)}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        </>
      }
    >
      <span className="uc-muted">{member.user.email}</span>
      <SelectField
        label="Status"
        value={status}
        onChange={(e) => setStatus(e.target.value as Member['status'])}
        options={[
          { value: 'active', label: 'Active' },
          { value: 'suspended', label: 'Suspended (cannot access this merchant)' },
        ]}
      />
      <RolePicker roles={roles} selected={roleIds} onChange={setRoleIds} />
      <ScopePicker locations={locations} value={scope} onChange={setScope} />
      {message && <Alert tone="danger">{message}</Alert>}
    </Dialog>
  );
}

function InviteDialog({
  roles,
  locations,
  onClose,
}: {
  roles: Role[];
  locations: Location[];
  onClose: () => void;
}) {
  const { api, tenantId } = useTenant();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [scope, setScope] = useState<string[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  // One key per dialog: double-submits replay instead of creating two invitations.
  const [idempotencyKey] = useState(newIdempotencyKey);
  const invite = useMutation({
    mutationFn: (body: unknown) =>
      api<CreateInvitationResponse>('/v1/admin/invitations', { method: 'POST', body, idempotencyKey }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['t', tenantId, 'invitations'] }),
    onError: (e) => {
      const r = serverErrors(e);
      setErrors(r.fields);
      setMessage(r.message);
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    const body = { email, roleIds, locationScope: scope };
    const check = validate(CreateInvitationRequest, body);
    if (!check.ok) return setErrors(check.errors);
    if (scope !== null && scope.length === 0)
      return setErrors({ locationScope: 'Pick at least one location or allow all' });
    setErrors({});
    invite.mutate(body);
  }
  return (
    <Dialog
      open
      title="Invite staff"
      onClose={onClose}
      footer={
        invite.isSuccess ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" form="invite-form" loading={invite.isPending}>
              Create invitation
            </Button>
          </>
        )
      }
    >
      {invite.isSuccess ? (
        <div className="uc-stack">
          <Alert tone="success" title="Invitation created">
            No email is sent by the platform yet. Copy this link now and share it securely with{' '}
            {invite.data.invitation.email} — it is shown only once and expires{' '}
            {formatDateTime(invite.data.invitation.expiresAt)}.
          </Alert>
          <div className="uc-code-box" aria-label="Invitation link">
            {invite.data.inviteUrl}
          </div>
          <Button onClick={() => void navigator.clipboard.writeText(invite.data.inviteUrl)}>Copy link</Button>
        </div>
      ) : (
        <form id="invite-form" className="uc-stack" onSubmit={submit} noValidate>
          <TextField
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={errors.email}
          />
          <RolePicker roles={roles} selected={roleIds} onChange={setRoleIds} />
          {errors.roleIds && <span className="uc-error">{errors.roleIds}</span>}
          <ScopePicker locations={locations} value={scope} onChange={setScope} />
          {errors.locationScope && <span className="uc-error">{errors.locationScope}</span>}
          {message && <Alert tone="danger">{message}</Alert>}
        </form>
      )}
    </Dialog>
  );
}

export default function StaffPage() {
  const { can, api, tenantId, context } = useTenant();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  const [roleId, setRoleId] = useState('');
  const [inviteStatus, setInviteStatus] = useState('pending');
  const [editing, setEditing] = useState<Member | null>(null);
  const [inviting, setInviting] = useState(false);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const memberFilters = { q: debounced, status, roleId };
  const memberPager = useCursorPagination(JSON.stringify(memberFilters));
  const invitePager = useCursorPagination(inviteStatus);
  const members = useTenantQuery<Page<Member>>(
    ['members'],
    '/v1/admin/members',
    { ...memberFilters, cursor: memberPager.cursor },
    can('staff.read'),
  );
  const invitations = useTenantQuery<Page<Invitation>>(
    ['invitations'],
    '/v1/admin/invitations',
    { status: inviteStatus, cursor: invitePager.cursor },
    can('staff.read'),
  );
  const roles = useTenantQuery<{ items: Role[] }>(['roles'], '/v1/admin/roles', undefined, can('roles.read'));
  const locations = useTenantQuery<Page<Location>>(
    ['locations', 'active'],
    '/v1/admin/locations',
    { status: 'active', limit: 100 },
    can('locations.read'),
  );
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/v1/admin/invitations/${id}/revoke`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['t', tenantId, 'invitations'] });
      toast('Invitation revoked');
      setRevoking(null);
    },
  });

  if (!can('staff.read')) return <ForbiddenState />;
  const manage = can('staff.manage') && can('roles.read');
  const roleList = roles.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Staff"
        description="People who can sign in to this merchant, their roles and location access."
        actions={
          manage && (
            <Button variant="primary" onClick={() => setInviting(true)}>
              Invite staff
            </Button>
          )
        }
      />
      <Card title="Members">
        <div className="uc-filters" role="search">
          <TextField
            label="Search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name or email"
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
          {roleList.length > 0 && (
            <SelectField
              label="Role"
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
              options={[
                { value: '', label: 'Any role' },
                ...roleList.map((r) => ({ value: r.id, label: r.name })),
              ]}
            />
          )}
        </div>
        <DataTable
          caption="Staff members"
          rows={members.data?.items}
          isLoading={members.isLoading}
          error={members.error}
          onRetry={() => void members.refetch()}
          rowKey={(m) => m.id}
          pagination={memberPager.controls(members.data?.nextCursor)}
          empty={<EmptyState title="No staff match these filters" />}
          columns={[
            {
              key: 'name',
              header: 'Name',
              render: (m) => (
                <>
                  {m.user.displayName}
                  {m.id === context.membership.id && <span className="uc-muted"> (you)</span>}
                  <br />
                  <span className="uc-muted">{m.user.email}</span>
                </>
              ),
            },
            { key: 'roles', header: 'Roles', render: (m) => m.roles.map((r) => r.name).join(', ') },
            {
              key: 'scope',
              header: 'Locations',
              render: (m) => (m.locationScope === null ? 'All' : `${m.locationScope.length} assigned`),
            },
            { key: 'status', header: 'Status', render: (m) => <StatusBadge status={m.status} /> },
            {
              key: 'actions',
              header: 'Actions',
              render: (m) =>
                manage && m.id !== context.membership.id ? (
                  <Button size="sm" onClick={() => setEditing(m)}>
                    Edit<span className="uc-sr-only"> {m.user.email}</span>
                  </Button>
                ) : null,
            },
          ]}
        />
      </Card>
      <Card title="Invitations">
        <div className="uc-filters">
          <SelectField
            label="Status"
            value={inviteStatus}
            onChange={(e) => setInviteStatus(e.target.value)}
            options={['pending', 'accepted', 'expired', 'revoked'].map((s) => ({ value: s, label: s }))}
          />
        </div>
        <DataTable
          caption="Invitations"
          rows={invitations.data?.items}
          isLoading={invitations.isLoading}
          error={invitations.error}
          onRetry={() => void invitations.refetch()}
          rowKey={(i) => i.id}
          pagination={invitePager.controls(invitations.data?.nextCursor)}
          empty={<EmptyState title={`No ${inviteStatus} invitations`} />}
          columns={[
            { key: 'email', header: 'Email', render: (i) => i.email },
            { key: 'roles', header: 'Roles', render: (i) => i.roles.map((r) => r.name).join(', ') },
            { key: 'by', header: 'Invited by', render: (i) => i.invitedBy?.email ?? '—' },
            {
              key: 'expires',
              header: 'Expires',
              render: (i) => formatDateTime(i.expiresAt, context.tenant.timezone),
            },
            { key: 'status', header: 'Status', render: (i) => <StatusBadge status={i.status} /> },
            {
              key: 'actions',
              header: 'Actions',
              render: (i) =>
                manage && i.status === 'pending' ? (
                  <Button size="sm" variant="danger" onClick={() => setRevoking(i)}>
                    Revoke<span className="uc-sr-only"> {i.email}</span>
                  </Button>
                ) : null,
            },
          ]}
        />
      </Card>
      {editing && (
        <MemberDialog
          member={editing}
          roles={roleList}
          locations={locations.data?.items ?? []}
          onClose={() => setEditing(null)}
        />
      )}
      {inviting && (
        <InviteDialog
          roles={roleList}
          locations={locations.data?.items ?? []}
          onClose={() => setInviting(false)}
        />
      )}
      <ConfirmDialog
        open={revoking !== null}
        title="Revoke invitation?"
        description={`The link sent to ${revoking?.email ?? ''} will stop working immediately.`}
        confirmLabel="Revoke"
        loading={revoke.isPending}
        error={revoke.error ? errorMessage(revoke.error) : null}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
        onClose={() => setRevoking(null)}
      />
    </>
  );
}
