'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CreateTenantRequest,
  PRESETS,
  PRESET_KEYS,
  type CreateTenantResponse,
  type Plan,
  type PresetKey,
} from '@uc/contracts';
import {
  Alert,
  apiRequest,
  ApiError,
  Button,
  Card,
  Checkbox,
  ForbiddenState,
  PageHeader,
  SelectField,
  TextField,
  formatDateTime,
  newIdempotencyKey,
  useUnsavedChangesWarning,
} from '@uc/ui';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { usePlatformMe, usePlatformQuery } from '../../../../lib/platform';

const initial = {
  slug: '',
  displayName: '',
  legalName: '',
  preset: 'b2c_jewellery' as PresetKey,
  countryCode: 'IN',
  defaultCurrency: 'INR',
  timezone: 'Asia/Kolkata',
  defaultLocale: 'en-IN',
  contactEmail: '',
  ownerEmail: '',
  isDemo: false,
  planKey: 'pilot',
};

export default function NewTenantPage() {
  const me = usePlatformMe();
  const queryClient = useQueryClient();
  const plans = usePlatformQuery<{ items: Plan[] }>(['plans'], '/v1/platform/plans');
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  // Stable per form: retries/double-clicks replay the first result instead of provisioning twice.
  const [idempotencyKey] = useState(newIdempotencyKey);
  const create = useMutation({
    mutationFn: (body: unknown) =>
      apiRequest<CreateTenantResponse>('/v1/platform/tenants', { method: 'POST', body, idempotencyKey }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['p', 'tenants'] }),
    onError: (e) => {
      if (e instanceof ApiError) {
        const fields = e.fieldErrors();
        if (e.code === 'DUPLICATE') fields.slug = 'This slug is already taken';
        setErrors(fields);
        setMessage(Object.keys(fields).length ? null : e.message);
      } else setMessage('Provisioning failed');
    },
  });
  const dirty = JSON.stringify(form) !== JSON.stringify(initial) && !create.isSuccess;
  useUnsavedChangesWarning(dirty);

  if (!me.can('platform.tenants.manage')) return <ForbiddenState />;
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    const parsed = CreateTenantRequest.safeParse(form);
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    setErrors({});
    create.mutate(parsed.data);
  }

  if (create.isSuccess) {
    const { tenant, ownerInvitation } = create.data;
    return (
      <>
        <PageHeader title="Tenant provisioned" />
        <Card title={tenant.displayName}>
          <Alert
            tone="success"
            title="Created with default store, channel(s), main warehouse and system roles."
          >
            No email is sent by the platform yet. Share this one-time owner invitation link securely with{' '}
            {ownerInvitation.email}. It expires {formatDateTime(ownerInvitation.expiresAt)} and will not be
            shown again.
          </Alert>
          <div className="uc-code-box" aria-label="Owner invitation link">
            {ownerInvitation.inviteUrl}
          </div>
          <div className="uc-row">
            <Button onClick={() => void navigator.clipboard.writeText(ownerInvitation.inviteUrl)}>
              Copy link
            </Button>
            <Link className="uc-btn" data-variant="primary" href={`/tenants/${tenant.id}`}>
              Open tenant
            </Link>
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Provision tenant" description={<Link href="/tenants">Back to tenants</Link>} />
      <form onSubmit={submit} noValidate className="uc-stack">
        <Card title="Business profile">
          <div className="uc-form-grid">
            <TextField
              label="Display name"
              value={form.displayName}
              onChange={set('displayName')}
              error={errors.displayName}
            />
            <TextField
              label="Legal name"
              value={form.legalName}
              onChange={set('legalName')}
              error={errors.legalName}
            />
            <TextField
              label="Slug"
              value={form.slug}
              onChange={set('slug')}
              error={errors.slug}
              hint="Lower-case identifier, e.g. shree-jewels"
            />
            <TextField
              label="Contact email"
              type="email"
              value={form.contactEmail}
              onChange={set('contactEmail')}
              error={errors.contactEmail}
            />
          </div>
        </Card>
        <Card title="Commerce preset">
          <SelectField
            label="Preset"
            value={form.preset}
            onChange={set('preset')}
            options={PRESET_KEYS.map((k) => ({ value: k, label: PRESETS[k].label }))}
            hint="Determines default features and channels; can be overridden per feature later."
          />
          <SelectField
            label="Plan"
            value={form.planKey}
            onChange={set('planKey')}
            error={errors.planKey}
            options={(plans.data?.items ?? [])
              .filter((p) => p.status === 'active')
              .map((p) => ({ value: p.key, label: p.name }))}
            hint="Usage limits for products, staff seats, locations and domains. No billing is connected."
          />
        </Card>
        <Card title="Region">
          <div className="uc-form-grid">
            <TextField
              label="Country (ISO-2)"
              value={form.countryCode}
              onChange={set('countryCode')}
              error={errors.countryCode}
            />
            <TextField
              label="Currency (ISO-4217)"
              value={form.defaultCurrency}
              onChange={set('defaultCurrency')}
              error={errors.defaultCurrency}
            />
            <TextField
              label="Time zone (IANA)"
              value={form.timezone}
              onChange={set('timezone')}
              error={errors.timezone}
            />
            <TextField
              label="Locale"
              value={form.defaultLocale}
              onChange={set('defaultLocale')}
              error={errors.defaultLocale}
            />
          </div>
        </Card>
        <Card title="Owner">
          <TextField
            label="Owner email"
            type="email"
            value={form.ownerEmail}
            onChange={set('ownerEmail')}
            error={errors.ownerEmail}
            hint="Receives a one-time owner invitation link."
          />
          <Checkbox
            label="Demo tenant"
            description="Visibly labelled as demo data everywhere"
            checked={form.isDemo}
            onChange={(e) => setForm((f) => ({ ...f, isDemo: e.target.checked }))}
          />
        </Card>
        {message && <Alert tone="danger">{message}</Alert>}
        <div className="uc-row">
          <Button type="submit" variant="primary" loading={create.isPending}>
            Provision tenant
          </Button>
          <Link className="uc-btn" href="/tenants">
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}
