'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CHANNEL_TYPES, UpdateChannelRequest, type Channel, type ThemeTokens } from '@uc/contracts';
import {
  Alert,
  Button,
  Card,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  SelectField,
  StatusBadge,
  TextField,
  useToast,
  useUnsavedChangesWarning,
} from '@uc/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { serverErrors, validate } from '../../../../../../../lib/forms';
import { useTenant, useTenantQuery } from '../../../../../../../lib/tenant';

const COLOR_KEYS: (keyof ThemeTokens)[] = ['primaryColor', 'accentColor', 'backgroundColor', 'textColor'];
const FONT: Record<ThemeTokens['fontFamily'], string> = {
  system: 'system-ui, sans-serif',
  serif: 'Georgia, serif',
  sans: 'Helvetica, Arial, sans-serif',
};
const RADIUS: Record<ThemeTokens['radius'], string> = { none: '0', sm: '4px', md: '8px', lg: '16px' };

function ThemePreview({ theme }: { theme: ThemeTokens }) {
  return (
    <div
      aria-label="Theme preview"
      style={{
        background: theme.backgroundColor,
        color: theme.textColor,
        fontFamily: FONT[theme.fontFamily],
        borderRadius: RADIUS[theme.radius],
        border: '1px solid var(--uc-border)',
        padding: 16,
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 18 }}>{theme.brandName}</div>
      <p style={{ margin: '8px 0' }}>Preview of storefront brand tokens.</p>
      <span
        style={{
          background: theme.primaryColor,
          color: theme.backgroundColor,
          padding: '6px 12px',
          borderRadius: RADIUS[theme.radius],
          display: 'inline-block',
        }}
      >
        Primary
      </span>{' '}
      <span
        style={{
          background: theme.accentColor,
          color: theme.textColor,
          padding: '6px 12px',
          borderRadius: RADIUS[theme.radius],
          display: 'inline-block',
        }}
      >
        Accent
      </span>
    </div>
  );
}

export default function ChannelPage() {
  const { channelId } = useParams<{ channelId: string }>();
  const { can, api, tenantId } = useTenant();
  const toast = useToast();
  const queryClient = useQueryClient();
  const channel = useTenantQuery<Channel>(
    ['channels', channelId],
    `/v1/admin/channels/${channelId}`,
    undefined,
    can('stores.read'),
  );
  const [name, setName] = useState('');
  const [status, setStatus] = useState<'active' | 'inactive'>('active');
  const [theme, setTheme] = useState<ThemeTokens | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (channel.data) {
      setName(channel.data.name);
      setStatus(channel.data.status);
      setTheme(channel.data.theme);
    }
  }, [channel.data]);

  const dirty =
    !!channel.data &&
    (name !== channel.data.name ||
      status !== channel.data.status ||
      JSON.stringify(theme) !== JSON.stringify(channel.data.theme));
  useUnsavedChangesWarning(dirty);

  const save = useMutation({
    mutationFn: (body: unknown) => api<Channel>(`/v1/admin/channels/${channelId}`, { method: 'PATCH', body }),
    onSuccess: (data) => {
      queryClient.setQueryData(['t', tenantId, 'channels', channelId, {}], data);
      void queryClient.invalidateQueries({ queryKey: ['t', tenantId, 'channels'] });
      toast('Channel saved');
    },
    onError: (e) => {
      const r = serverErrors(e);
      setErrors(r.fields);
      setMessage(r.message);
    },
  });

  if (!can('stores.read')) return <ForbiddenState />;
  if (channel.error) return <ErrorState error={channel.error} onRetry={() => void channel.refetch()} />;
  if (channel.isLoading || !channel.data || !theme) return <LoadingState />;
  const readOnly = !can('stores.manage');

  function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    const body = { version: channel.data!.version, name, status, theme };
    const check = validate(UpdateChannelRequest, body);
    if (!check.ok) return setErrors(check.errors);
    setErrors({});
    save.mutate(body);
  }
  const setT = <K extends keyof ThemeTokens>(key: K, value: ThemeTokens[K]) =>
    setTheme((t) => (t ? { ...t, [key]: value } : t));

  return (
    <>
      <PageHeader
        title={channel.data.name}
        description={
          <>
            <Link href={`/t/${tenantId}/settings/stores`}>Stores & channels</Link> ·{' '}
            {CHANNEL_TYPES[channel.data.type].label} · <span className="uc-mono">{channel.data.code}</span>
          </>
        }
      />
      <form onSubmit={submit} noValidate className="uc-stack">
        <Card
          title="Channel"
          actions={
            !readOnly && (
              <Button type="submit" variant="primary" disabled={!dirty} loading={save.isPending}>
                Save
              </Button>
            )
          }
        >
          {message && <Alert tone="danger">{message}</Alert>}
          <div className="uc-form-grid">
            <TextField
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              error={errors.name}
              disabled={readOnly}
            />
            <SelectField
              label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value as 'active' | 'inactive')}
              disabled={readOnly}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'inactive', label: 'Inactive' },
              ]}
            />
          </div>
        </Card>
        <Card title="Brand theme tokens">
          <div className="uc-form-grid">
            <TextField
              label="Brand name"
              value={theme.brandName}
              onChange={(e) => setT('brandName', e.target.value)}
              error={errors['theme.brandName']}
              disabled={readOnly}
            />
            {COLOR_KEYS.map((key) => (
              <TextField
                key={key}
                label={key.replace('Color', ' colour').replace(/^./, (c) => c.toUpperCase())}
                value={theme[key] as string}
                onChange={(e) => setT(key, e.target.value as never)}
                error={errors[`theme.${key}`]}
                disabled={readOnly}
                hint={
                  <span>
                    <span
                      className="uc-swatch"
                      style={{
                        background: /^#[0-9a-f]{6}$/i.test(theme[key] as string)
                          ? (theme[key] as string)
                          : 'transparent',
                      }}
                    />{' '}
                    hex #rrggbb
                  </span>
                }
              />
            ))}
            <SelectField
              label="Font"
              value={theme.fontFamily}
              onChange={(e) => setT('fontFamily', e.target.value as ThemeTokens['fontFamily'])}
              disabled={readOnly}
              options={[
                { value: 'system', label: 'System' },
                { value: 'sans', label: 'Sans-serif' },
                { value: 'serif', label: 'Serif' },
              ]}
            />
            <SelectField
              label="Corner radius"
              value={theme.radius}
              onChange={(e) => setT('radius', e.target.value as ThemeTokens['radius'])}
              disabled={readOnly}
              options={(['none', 'sm', 'md', 'lg'] as const).map((r) => ({ value: r, label: r }))}
            />
            <TextField
              label="Logo URL (https)"
              value={theme.logoUrl ?? ''}
              onChange={(e) => setT('logoUrl', e.target.value || null)}
              error={errors['theme.logoUrl']}
              disabled={readOnly}
            />
          </div>
          <ThemePreview theme={theme} />
        </Card>
        <Card title="Domains">
          {channel.data.domains.length === 0 ? (
            <p className="uc-muted">
              No domains. Domain connection and DNS verification arrive with Online Store (Phase 10).
            </p>
          ) : (
            <ul className="uc-stack" style={{ margin: 0, paddingLeft: 18 }}>
              {channel.data.domains.map((d) => (
                <li key={d.hostname} className="uc-row">
                  <span className="uc-mono">{d.hostname}</span> <StatusBadge status={d.status} />{' '}
                  {d.isPrimary && <span className="uc-muted">primary</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </form>
    </>
  );
}
