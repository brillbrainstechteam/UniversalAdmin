'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UpdateTenantSettingsRequest, type TenantSettings } from '@uc/contracts';
import {
  Alert,
  Button,
  Card,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  TextField,
  formatDateTime,
  useToast,
  useUnsavedChangesWarning,
} from '@uc/ui';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { changedFields, serverErrors, validate } from '../../../../../lib/forms';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

type Editable = Pick<
  TenantSettings,
  'displayName' | 'legalName' | 'contactEmail' | 'contactPhone' | 'timezone' | 'defaultLocale'
>;

const pick = (s: TenantSettings): Editable => ({
  displayName: s.displayName,
  legalName: s.legalName,
  contactEmail: s.contactEmail ?? '',
  contactPhone: s.contactPhone ?? '',
  timezone: s.timezone,
  defaultLocale: s.defaultLocale,
});

export default function GeneralSettingsPage() {
  const { can, api, tenantId } = useTenant();
  const toast = useToast();
  const queryClient = useQueryClient();
  const settings = useTenantQuery<TenantSettings>(
    ['settings-general'],
    '/v1/admin/settings/general',
    undefined,
    can('settings.read'),
  );
  const [form, setForm] = useState<Editable | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data) setForm(pick(settings.data));
  }, [settings.data]);

  const original = useMemo(() => (settings.data ? pick(settings.data) : null), [settings.data]);
  const changes = form && original ? changedFields(original, form) : {};
  const dirty = Object.keys(changes).length > 0;
  useUnsavedChangesWarning(dirty);
  const readOnly = !can('settings.manage');

  const save = useMutation({
    mutationFn: (body: unknown) =>
      api<TenantSettings>('/v1/admin/settings/general', { method: 'PATCH', body }),
    onSuccess: (data) => {
      queryClient.setQueryData(['t', tenantId, 'settings-general', {}], data);
      void queryClient.invalidateQueries({ queryKey: ['context', tenantId] });
      toast('Business settings saved');
    },
    onError: (error) => {
      const { fields, message } = serverErrors(error);
      setErrors(fields);
      setFormError(message);
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!form || !settings.data) return;
    setFormError(null);
    const body = {
      version: settings.data.version,
      ...changes,
      ...(changes.contactEmail !== undefined ? { contactEmail: form.contactEmail || null } : {}),
      ...(changes.contactPhone !== undefined ? { contactPhone: form.contactPhone || null } : {}),
    };
    const check = validate(UpdateTenantSettingsRequest, body);
    if (!check.ok) return setErrors(check.errors);
    setErrors({});
    save.mutate(body);
  }

  if (!can('settings.read')) return <ForbiddenState />;
  const set = (key: keyof Editable) => (e: { target: { value: string } }) =>
    setForm((f) => (f ? { ...f, [key]: e.target.value } : f));

  return (
    <>
      <PageHeader title="General" description="Business identity and regional defaults for this merchant." />
      {settings.isLoading || !form ? (
        settings.error ? (
          <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
        ) : (
          <LoadingState />
        )
      ) : (
        <form onSubmit={onSubmit} noValidate>
          <Card
            title="Business profile"
            actions={
              !readOnly && (
                <>
                  <Button disabled={!dirty || save.isPending} onClick={() => original && setForm(original)}>
                    Discard
                  </Button>
                  <Button type="submit" variant="primary" disabled={!dirty} loading={save.isPending}>
                    Save
                  </Button>
                </>
              )
            }
          >
            {readOnly && (
              <Alert tone="info">
                You can view these settings. Editing requires the “Edit business settings” permission.
              </Alert>
            )}
            {formError && (
              <Alert tone="danger" title="Not saved">
                {formError}
                {formError.includes('Reload') && (
                  <p>
                    <Button size="sm" onClick={() => void settings.refetch()}>
                      Reload latest
                    </Button>
                  </p>
                )}
              </Alert>
            )}
            <div className="uc-form-grid">
              <TextField
                label="Display name"
                value={form.displayName}
                onChange={set('displayName')}
                error={errors.displayName}
                disabled={readOnly}
                required
              />
              <TextField
                label="Legal name"
                value={form.legalName}
                onChange={set('legalName')}
                error={errors.legalName}
                disabled={readOnly}
                required
              />
              <TextField
                label="Contact email"
                type="email"
                value={form.contactEmail ?? ''}
                onChange={set('contactEmail')}
                error={errors.contactEmail}
                disabled={readOnly}
              />
              <TextField
                label="Contact phone"
                type="tel"
                value={form.contactPhone ?? ''}
                onChange={set('contactPhone')}
                error={errors.contactPhone}
                disabled={readOnly}
              />
              <TextField
                label="Time zone (IANA)"
                value={form.timezone}
                onChange={set('timezone')}
                error={errors.timezone}
                disabled={readOnly}
                hint="e.g. Asia/Kolkata"
              />
              <TextField
                label="Default locale"
                value={form.defaultLocale}
                onChange={set('defaultLocale')}
                error={errors.defaultLocale}
                disabled={readOnly}
                hint="e.g. en-IN"
              />
              <TextField
                label="Country"
                value={settings.data!.countryCode}
                disabled
                hint="Set by the platform at onboarding"
              />
              <TextField
                label="Default currency"
                value={settings.data!.defaultCurrency}
                disabled
                hint="Set by the platform at onboarding"
              />
            </div>
            <span className="uc-muted">
              Version {settings.data!.version} · last updated {formatDateTime(settings.data!.updatedAt)}
            </span>
          </Card>
        </form>
      )}
    </>
  );
}
