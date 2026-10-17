'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CreateRoleRequest, type PermissionCatalog, type Role } from '@uc/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  ForbiddenState,
  PageHeader,
  TextField,
  useToast,
} from '@uc/ui';
import { useState, type FormEvent } from 'react';
import { serverErrors, validate } from '../../../../../lib/forms';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

function RoleDialog({
  role,
  catalog,
  onClose,
}: {
  role: Role | 'new';
  catalog: PermissionCatalog;
  onClose: () => void;
}) {
  const { api, tenantId, can, context } = useTenant();
  const toast = useToast();
  const queryClient = useQueryClient();
  const isNew = role === 'new';
  const existing = isNew ? null : role;
  const readOnly = !!existing?.isSystem || !can('roles.manage');
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [permissions, setPermissions] = useState<string[]>(existing?.permissions ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const groups = [...new Set(catalog.items.map((p) => p.group))];
  const isOwner = context.membership.roles.some((r) => r.key === 'owner');
  const save = useMutation({
    mutationFn: (body: unknown) =>
      isNew
        ? api<Role>('/v1/admin/roles', { method: 'POST', body })
        : api<Role>(`/v1/admin/roles/${existing!.id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['t', tenantId, 'roles'] });
      toast(isNew ? 'Role created' : 'Role updated');
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
    const body = isNew
      ? { name, description, permissions }
      : { version: existing!.version, name, description, permissions };
    if (isNew) {
      const check = validate(CreateRoleRequest, body);
      if (!check.ok) return setErrors(check.errors);
    }
    setErrors({});
    save.mutate(body);
  }
  return (
    <Dialog
      open
      title={isNew ? 'New custom role' : readOnly ? existing!.name : `Edit ${existing!.name}`}
      onClose={onClose}
      footer={
        readOnly ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" form="role-form" loading={save.isPending}>
              Save
            </Button>
          </>
        )
      }
    >
      <form id="role-form" className="uc-stack" onSubmit={submit} noValidate>
        {existing?.isSystem && (
          <Alert tone="info">
            System roles are maintained by the platform and cannot be edited. Create a custom role to tailor
            permissions.
          </Alert>
        )}
        {!readOnly && !isOwner && (
          <Alert tone="info">You can only grant permissions you hold yourself.</Alert>
        )}
        <TextField
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
          disabled={readOnly}
        />
        <TextField
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={readOnly}
        />
        {groups.map((group) => (
          <fieldset key={group} className="uc-fieldset">
            <legend>{group}</legend>
            <div className="uc-stack" style={{ gap: 6 }}>
              {catalog.items
                .filter((p) => p.group === group)
                .map((p) => (
                  <Checkbox
                    key={p.key}
                    label={p.label}
                    description={p.phase > 1 ? `${p.key} · enforced from phase ${p.phase}` : p.key}
                    checked={permissions.includes(p.key)}
                    disabled={readOnly || (!isOwner && !context.permissions.includes(p.key))}
                    onChange={(e) =>
                      setPermissions((cur) =>
                        e.target.checked ? [...cur, p.key] : cur.filter((x) => x !== p.key),
                      )
                    }
                  />
                ))}
            </div>
          </fieldset>
        ))}
        {message && <Alert tone="danger">{message}</Alert>}
      </form>
    </Dialog>
  );
}

export default function RolesPage() {
  const { can } = useTenant();
  const roles = useTenantQuery<{ items: Role[] }>(['roles'], '/v1/admin/roles', undefined, can('roles.read'));
  const catalog = useTenantQuery<PermissionCatalog>(
    ['permissions'],
    '/v1/admin/permissions',
    undefined,
    can('roles.read'),
  );
  const [open, setOpen] = useState<Role | 'new' | null>(null);
  if (!can('roles.read')) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="Roles"
        description="Roles bundle permissions. A member’s access is the union of their roles, limited by their location scope."
        actions={
          can('roles.manage') && (
            <Button variant="primary" onClick={() => setOpen('new')} disabled={!catalog.data}>
              New custom role
            </Button>
          )
        }
      />
      <Card>
        <DataTable
          caption="Roles"
          rows={roles.data?.items}
          isLoading={roles.isLoading}
          error={roles.error}
          onRetry={() => void roles.refetch()}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No roles" />}
          columns={[
            {
              key: 'name',
              header: 'Role',
              render: (r) => (
                <>
                  {r.name} {r.isSystem && <Badge>System</Badge>}
                  <br />
                  <span className="uc-muted">{r.description}</span>
                </>
              ),
            },
            { key: 'perms', header: 'Permissions', render: (r) => r.permissions.length },
            { key: 'members', header: 'Active members', render: (r) => r.memberCount },
            {
              key: 'actions',
              header: 'Actions',
              render: (r) => (
                <Button size="sm" onClick={() => setOpen(r)} disabled={!catalog.data}>
                  {r.isSystem || !can('roles.manage') ? 'View' : 'Edit'}
                  <span className="uc-sr-only"> {r.name}</span>
                </Button>
              ),
            },
          ]}
        />
      </Card>
      {open && catalog.data && (
        <RoleDialog role={open} catalog={catalog.data} onClose={() => setOpen(null)} />
      )}
    </>
  );
}
