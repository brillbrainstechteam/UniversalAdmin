'use client';

import type { OrderReturn, Page } from '@uc/contracts';
import {
  Card,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  SelectField,
  useCursorPagination,
} from '@uc/ui';
import { useState } from 'react';
import { ReturnTable } from '../../../../../lib/fulfillment';
import { OrdersTabs } from '../../../../../lib/orders';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

export default function ReturnsPage() {
  const { can, context } = useTenant();
  const enabled = can('orders.read') && context.features.includes('fulfillment');
  const [status, setStatus] = useState('requested');
  const pager = useCursorPagination(status);
  const list = useTenantQuery<Page<OrderReturn>>(
    ['returns', 'list'],
    '/v1/admin/returns',
    { status, cursor: pager.cursor, limit: 25 },
    enabled,
  );
  if (!enabled) return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="Returns"
        description="Customer and staff return requests. Approve, then receive the goods: restock them or record them as not restocked."
      />
      <OrdersTabs />
      <Card>
        <div className="uc-filters" role="search">
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: '', label: 'Any' },
              ...['requested', 'approved', 'rejected', 'received'].map((s) => ({ value: s, label: s })),
            ]}
          />
        </div>
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.data ? (
          <LoadingState />
        ) : (
          <ReturnTable rows={list.data.items} showOrder pagination={pager.controls(list.data.nextCursor)} />
        )}
      </Card>
    </>
  );
}
