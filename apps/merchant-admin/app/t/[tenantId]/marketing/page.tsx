'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  currencyMinorUnits,
  formatMinor,
  type Campaign,
  type Page,
  type Segment,
  type SegmentDefinition,
} from '@uc/contracts';
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
  errorMessage,
  formatDateTime,
  useToast,
} from '@uc/ui';
import { useState } from 'react';
import { majorToMinor } from '../../../../lib/growth';
import { useTenant, useTenantQuery } from '../../../../lib/tenant';

const numOrNull = (v: string) => (v.trim() ? Number.parseInt(v, 10) : null);

function describe(d: SegmentDefinition, currency: string) {
  const mu = currencyMinorUnits(currency);
  return (
    [
      d.minOrders !== null ? `${d.minOrders}+ orders` : null,
      d.minSpentMinor !== null ? `spent ${currency} ${formatMinor(d.minSpentMinor, mu)}+` : null,
      d.orderedWithinDays !== null ? `ordered in last ${d.orderedWithinDays} days` : null,
      d.registeredWithinDays !== null ? `joined in last ${d.registeredWithinDays} days` : null,
      d.consentChannel ? `${d.consentChannel} consent` : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'All active customers'
  );
}

export default function MarketingPage() {
  const { api, can, tenantId, context } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const tz = context.tenant.timezone;
  const currency = context.tenant.defaultCurrency;
  const enabled = can('marketing.manage') && context.features.includes('marketing');
  const segments = useTenantQuery<{ items: Segment[] }>(
    ['segments'],
    '/v1/admin/marketing/segments',
    undefined,
    enabled,
  );
  const campaigns = useTenantQuery<Page<Campaign>>(
    ['campaigns'],
    '/v1/admin/marketing/campaigns',
    { limit: 50 },
    enabled,
  );
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['t', tenantId, 'segments'] });
    void qc.invalidateQueries({ queryKey: ['t', tenantId, 'campaigns'] });
  };
  const [seg, setSeg] = useState<null | {
    name: string;
    minOrders: string;
    minSpent: string;
    ordered: string;
    registered: string;
    consent: string;
  }>(null);
  const [camp, setCamp] = useState<null | {
    name: string;
    channel: string;
    segmentId: string;
    subject: string;
    body: string;
  }>(null);
  const saveSeg = useMutation({
    mutationFn: () => {
      const spent = majorToMinor(seg!.minSpent, currencyMinorUnits(currency));
      if (spent === 'invalid') throw new Error('Enter the minimum spend as an amount like 100.00');
      return api('/v1/admin/marketing/segments', {
        method: 'POST',
        body: {
          name: seg!.name.trim(),
          definition: {
            minOrders: numOrNull(seg!.minOrders),
            minSpentMinor: spent,
            orderedWithinDays: numOrNull(seg!.ordered),
            registeredWithinDays: numOrNull(seg!.registered),
            consentChannel: seg!.consent || null,
          },
        },
      });
    },
    onSuccess: () => {
      setSeg(null);
      refresh();
      toast('Segment saved');
    },
  });
  const saveCamp = useMutation({
    mutationFn: () =>
      api('/v1/admin/marketing/campaigns', {
        method: 'POST',
        body: {
          name: camp!.name.trim(),
          channel: camp!.channel,
          segmentId: camp!.segmentId,
          subject: camp!.subject.trim() || null,
          body: camp!.body.trim(),
        },
      }),
    onSuccess: () => {
      setCamp(null);
      refresh();
      toast('Campaign draft saved');
    },
  });
  const prepare = useMutation({
    mutationFn: (c: Campaign) =>
      api(`/v1/admin/marketing/campaigns/${c.id}/prepare`, { method: 'POST', body: { version: c.version } }),
    onSuccess: () => {
      refresh();
      toast('Audience prepared (not sent)');
    },
  });
  if (!enabled) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="Marketing"
        description="Customer segments and campaigns. Campaigns only ever reach customers whose latest consent for that channel is yes."
      />
      <Alert tone="warning" title="Sending is not available yet">
        No e-mail, SMS or WhatsApp provider is connected. You can prepare a campaign&apos;s audience; nothing
        is sent.
      </Alert>
      <Card
        title="Segments"
        actions={
          <Button
            size="sm"
            onClick={() =>
              setSeg({ name: '', minOrders: '', minSpent: '', ordered: '', registered: '', consent: '' })
            }
          >
            New segment
          </Button>
        }
      >
        <DataTable
          caption="Segments"
          rows={segments.data?.items}
          isLoading={segments.isLoading}
          error={segments.error}
          rowKey={(s) => s.id}
          empty={<EmptyState title="No segments yet" />}
          columns={[
            { key: 'n', header: 'Segment', render: (s) => s.name },
            { key: 'r', header: 'Rules', render: (s) => describe(s.definition, currency) },
            { key: 'c', header: 'Customers now', render: (s) => s.customerCount },
          ]}
        />
      </Card>
      <Card
        title="Campaigns"
        actions={
          <Button
            size="sm"
            disabled={!segments.data?.items.length}
            onClick={() =>
              setCamp({
                name: '',
                channel: 'email',
                segmentId: segments.data!.items[0]!.id,
                subject: '',
                body: '',
              })
            }
          >
            New campaign
          </Button>
        }
      >
        <DataTable
          caption="Campaigns"
          rows={campaigns.data?.items}
          isLoading={campaigns.isLoading}
          error={campaigns.error}
          rowKey={(c) => c.id}
          empty={<EmptyState title="No campaigns yet" />}
          columns={[
            { key: 'n', header: 'Campaign', render: (c) => c.name },
            { key: 'ch', header: 'Channel', render: (c) => c.channel },
            { key: 's', header: 'Segment', render: (c) => c.segment.name },
            {
              key: 'st',
              header: 'Status',
              render: (c) => (
                <Badge tone={c.status === 'prepared' ? 'info' : undefined}>
                  {c.status === 'prepared' ? 'audience prepared — not sent' : 'draft'}
                </Badge>
              ),
            },
            {
              key: 'a',
              header: 'Audience',
              render: (c) =>
                c.status === 'prepared'
                  ? `${c.recipientCount} with consent · ${c.excludedNoConsent} excluded`
                  : '—',
            },
            {
              key: 'w',
              header: 'Prepared',
              render: (c) => (c.preparedAt ? formatDateTime(c.preparedAt, tz) : '—'),
            },
            {
              key: 'x',
              header: 'Actions',
              render: (c) =>
                c.status === 'draft' && (
                  <Button
                    size="sm"
                    variant="primary"
                    loading={prepare.isPending && prepare.variables?.id === c.id}
                    onClick={() => prepare.mutate(c)}
                  >
                    Prepare audience
                  </Button>
                ),
            },
          ]}
        />
        {prepare.error && <Alert tone="danger">{errorMessage(prepare.error)}</Alert>}
      </Card>
      <Dialog
        open={seg !== null}
        title="New segment"
        onClose={() => setSeg(null)}
        footer={
          <>
            <Button onClick={() => setSeg(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!seg?.name.trim()}
              loading={saveSeg.isPending}
              onClick={() => saveSeg.mutate()}
            >
              Save
            </Button>
          </>
        }
      >
        {seg && (
          <div className="uc-form-grid">
            <TextField
              label="Name"
              value={seg.name}
              onChange={(e) => setSeg({ ...seg, name: e.target.value })}
            />
            <TextField
              label="At least this many orders"
              inputMode="numeric"
              value={seg.minOrders}
              onChange={(e) => setSeg({ ...seg, minOrders: e.target.value.replace(/\D/g, '') })}
            />
            <TextField
              label={`Spent at least (${currency})`}
              inputMode="decimal"
              value={seg.minSpent}
              onChange={(e) => setSeg({ ...seg, minSpent: e.target.value })}
            />
            <TextField
              label="Ordered in the last N days"
              inputMode="numeric"
              value={seg.ordered}
              onChange={(e) => setSeg({ ...seg, ordered: e.target.value.replace(/\D/g, '') })}
            />
            <TextField
              label="Joined in the last N days"
              inputMode="numeric"
              value={seg.registered}
              onChange={(e) => setSeg({ ...seg, registered: e.target.value.replace(/\D/g, '') })}
            />
            <SelectField
              label="Only with marketing consent for"
              value={seg.consent}
              onChange={(e) => setSeg({ ...seg, consent: e.target.value })}
              options={[
                { value: '', label: 'Any (not required)' },
                { value: 'email', label: 'E-mail' },
                { value: 'sms', label: 'SMS' },
                { value: 'whatsapp', label: 'WhatsApp' },
              ]}
            />
          </div>
        )}
        {saveSeg.error && <Alert tone="danger">{errorMessage(saveSeg.error)}</Alert>}
      </Dialog>
      <Dialog
        open={camp !== null}
        title="New campaign"
        onClose={() => setCamp(null)}
        footer={
          <>
            <Button onClick={() => setCamp(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!camp?.name.trim() || !camp?.body.trim()}
              loading={saveCamp.isPending}
              onClick={() => saveCamp.mutate()}
            >
              Save draft
            </Button>
          </>
        }
      >
        {camp && (
          <>
            <div className="uc-form-grid">
              <TextField
                label="Name"
                value={camp.name}
                onChange={(e) => setCamp({ ...camp, name: e.target.value })}
              />
              <SelectField
                label="Channel"
                value={camp.channel}
                onChange={(e) => setCamp({ ...camp, channel: e.target.value })}
                options={[
                  { value: 'email', label: 'E-mail' },
                  { value: 'sms', label: 'SMS' },
                  { value: 'whatsapp', label: 'WhatsApp' },
                ]}
              />
              <SelectField
                label="Segment"
                value={camp.segmentId}
                onChange={(e) => setCamp({ ...camp, segmentId: e.target.value })}
                options={(segments.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))}
              />
              {camp.channel === 'email' && (
                <TextField
                  label="Subject"
                  value={camp.subject}
                  onChange={(e) => setCamp({ ...camp, subject: e.target.value })}
                />
              )}
            </div>
            <label className="uc-field">
              <span className="uc-label">Message</span>
              <textarea
                className="uc-input"
                rows={5}
                value={camp.body}
                onChange={(e) => setCamp({ ...camp, body: e.target.value })}
              />
            </label>
          </>
        )}
        {saveCamp.error && <Alert tone="danger">{errorMessage(saveCamp.error)}</Alert>}
      </Dialog>
    </>
  );
}
