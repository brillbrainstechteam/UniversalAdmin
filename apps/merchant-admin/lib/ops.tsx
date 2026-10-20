'use client';

import Link from 'next/link';
import { useTenant, useTenantQuery } from './tenant';

/** Top-bar link to the staff inbox with the unread count. */
export function InboxLink() {
  const { tenantId } = useTenant();
  const inbox = useTenantQuery<{ unread: number }>(['notifications'], '/v1/admin/notifications');
  const unread = inbox.data?.unread ?? 0;
  return (
    <Link
      href={`/t/${tenantId}/inbox`}
      className="uc-btn"
      data-size="sm"
      aria-label={unread ? `Inbox, ${unread} unread` : 'Inbox'}
    >
      Inbox{unread ? ` (${unread})` : ''}
    </Link>
  );
}
