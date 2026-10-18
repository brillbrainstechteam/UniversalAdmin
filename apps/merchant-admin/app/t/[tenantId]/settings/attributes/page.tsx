'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CreateAttributeDefinitionRequest, type AttributeDefinition } from '@uc/contracts';
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
  SelectField,
  TextField,
  useToast,
} from '@uc/ui';
import { useState } from 'react';
import { serverErrors, validate } from '../../../../../lib/forms';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

const TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number (exact decimal)' },
  { value: 'boolean', label: 'Yes / No' },
  { value: 'select', label: 'Select from list' },
];

function AttributeDialog({ attr, onClose }: { attr: AttributeDefinition | 'new'; onClose: () => void }) {
  const { api, tenantId } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const isNew = attr === 'new';
  const a = isNew ? null : attr;
  const [form, setForm] = useState({
    key: a?.key ?? '',
    label: a?.label ?? '',
    type: a?.type ?? 'text',
    options: a?.options.join(', ') ?? '',
    required: a?.required ?? false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const options = form.options
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const save = useMutation({
    mutationFn: (body: unknown) =>
      isNew
        ? api('/v1/admin/attribute-definitions', { method: 'POST', body })
        : api(`/v1/admin/attribute-definitions/${a!.id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['t', tenantId, 'attributes'] });
      toast('Attribute saved');
      onClose();
    },
    onError: (e) => {
      const r = serverErrors(e);
      setErrors(r.fields);
      setMessage(r.message);
    },
  });
  function submit() {
    if (isNew) {
      const body = { key: form.key, label: form.label, type: form.type, options, required: form.required };
      const check = validate(CreateAttributeDefinitionRequest, body);
      if (!check.ok) return setErrors(check.errors);
      save.mutate(body);
    } else {
      save.mutate({
        version: a!.version,
        label: form.label,
        required: form.required,
        ...(a!.type === 'select' ? { options } : {}),
      });
    }
  }
  return (
    <Dialog
      open
      title={isNew ? 'New attribute' : `Edit ${a!.label}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <TextField
        label="Key"
        value={form.key}
        error={errors.key}
        disabled={!isNew}
        onChange={(e) => setForm({ ...form, key: e.target.value })}
        hint="lower_snake_case; cannot change later"
      />
      <TextField
        label="Label"
        value={form.label}
        error={errors.label}
        onChange={(e) => setForm({ ...form, label: e.target.value })}
      />
      <SelectField
        label="Type"
        value={form.type}
        disabled={!isNew}
        onChange={(e) => setForm({ ...form, type: e.target.value as AttributeDefinition['type'] })}
        options={TYPES}
      />
      {form.type === 'select' && (
        <TextField
          label="Options (comma separated)"
          value={form.options}
          error={errors.options}
          onChange={(e) => setForm({ ...form, options: e.target.value })}
        />
      )}
      <Checkbox
        label="Required on every product"
        checked={form.required}
        onChange={(e) => setForm({ ...form, required: e.target.checked })}
      />
      {message && <Alert tone="danger">{message}</Alert>}
    </Dialog>
  );
}

export default function AttributesPage() {
  const { can } = useTenant();
  const list = useTenantQuery<{ items: AttributeDefinition[] }>(
    ['attributes'],
    '/v1/admin/attribute-definitions',
    undefined,
    can('catalog.read'),
  );
  const [editing, setEditing] = useState<AttributeDefinition | 'new' | null>(null);
  if (!can('catalog.read')) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="Product attributes"
        description="Structured, validated product properties (e.g. material, finish). Jewellery measurements are dedicated fields from Phase 03, not attributes."
        actions={
          can('catalog.edit') && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              New attribute
            </Button>
          )
        }
      />
      <Card>
        <DataTable
          caption="Attribute definitions"
          rows={list.data?.items}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(a) => a.id}
          empty={<EmptyState title="No attributes defined" />}
          columns={[
            {
              key: 'label',
              header: 'Label',
              render: (a) => (
                <>
                  {a.label} {a.required && <Badge tone="warning">Required</Badge>}
                </>
              ),
            },
            { key: 'key', header: 'Key', render: (a) => <span className="uc-mono">{a.key}</span> },
            { key: 'type', header: 'Type', render: (a) => TYPES.find((t) => t.value === a.type)?.label },
            { key: 'options', header: 'Options', render: (a) => a.options.join(', ') || '—' },
            {
              key: 'actions',
              header: 'Actions',
              render: (a) =>
                can('catalog.edit') ? (
                  <Button size="sm" onClick={() => setEditing(a)}>
                    Edit<span className="uc-sr-only"> {a.label}</span>
                  </Button>
                ) : null,
            },
          ]}
        />
      </Card>
      {editing && <AttributeDialog attr={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
