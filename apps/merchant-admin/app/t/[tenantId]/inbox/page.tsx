'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  formatDateTime,
} from '@uc/ui';
import Link from 'next/link';
import { useTenant, useTenantQuery } from '../../../../lib/tenant';

interface Item {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  source: string;
  read: boolean;
  createdAt: string;
}

export default function InboxPage() {
  const { api, tenantId, context } = useTenant();
  const qc = useQueryClient();
  const inbox = useTenantQuery<{ items: Item[]; unread: number }>(
    ['notifications'],
    '/v1/admin/notifications',
  );
  const read = useMutation({
    mutationFn: (ids: string[]) => api('/v1/admin/notifications/read', { method: 'POST', body: { ids } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['t', tenantId, 'notifications'] }),
  });
  if (inbox.error) return <ErrorState error={inbox.error} onRetry={() => void inbox.refetch()} />;
  if (!inbox.data) return <LoadingState />;
  const unread = inbox.data.items.filter((i) => !i.read);
  return (
    <>
      <PageHeader
        title="Inbox"
        description="Notifications from automations and operations."
        actions={
          unread.length > 0 && (
            <Button onClick={() => read.mutate(unread.map((i) => i.id))}>Mark all read</Button>
          )
        }
      />
      <Card>
        {inbox.data.items.length === 0 ? (
          <EmptyState title="Nothing here yet" />
        ) : (
          <ul className="uc-stack" aria-label="Notifications" style={{ listStyle: 'none', padding: 0 }}>
            {inbox.data.items.map((n) => (
              <li key={n.id} style={{ borderBottom: '1px solid rgba(0,0,0,0.08)', paddingBottom: 8 }}>
                <div className="uc-row">
                  {!n.read && <Badge tone="info">new</Badge>}
                  <strong>
                    {n.link ? <Link href={`/t/${tenantId}${n.link}`}>{n.title}</Link> : n.title}
                  </strong>
                  <span className="uc-muted">{formatDateTime(n.createdAt, context.tenant.timezone)}</span>
                </div>
                {n.body && <div className="uc-muted">{n.body}</div>}
                <div className="uc-muted">From {n.source}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
