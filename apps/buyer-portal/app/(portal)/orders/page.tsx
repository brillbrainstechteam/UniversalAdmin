'use client';

import { Card, PageHeader } from '@uc/ui';
import { OrderTable } from '../../../lib/orders';

export default function OrdersPage() {
  return (
    <>
      <PageHeader title="Orders" description="Your company's orders for the locations you buy for." />
      <Card>
        <OrderTable caption="Orders" />
      </Card>
    </>
  );
}
