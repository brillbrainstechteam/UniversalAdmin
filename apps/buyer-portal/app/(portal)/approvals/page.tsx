'use client';

import { Card, ForbiddenState, PageHeader } from '@uc/ui';
import { useBuyer } from '../../../lib/buyer';
import { OrderTable } from '../../../lib/orders';

export default function ApprovalsPage() {
  const { me } = useBuyer();
  if (!me.company || me.company.role === 'buyer')
    return <ForbiddenState message="Only company approvers review orders." />;
  return (
    <>
      <PageHeader
        title="Approvals"
        description="Orders above a buyer's limit wait here. You cannot approve orders you placed yourself."
      />
      <Card>
        <OrderTable status="awaiting_buyer_approval" caption="Orders waiting for approval" />
      </Card>
    </>
  );
}
