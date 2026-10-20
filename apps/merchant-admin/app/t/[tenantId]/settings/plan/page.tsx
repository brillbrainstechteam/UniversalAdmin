'use client';

import type { PlanUsage } from '@uc/contracts';
import { Card, ErrorState, LoadingState, PageHeader, UsageTable } from '@uc/ui';
import { useTenant, useTenantQuery } from '../../../../../lib/tenant';

export default function PlanPage() {
  const { context } = useTenant();
  const q = useTenantQuery<PlanUsage>(['plan'], '/v1/admin/plan');
  return (
    <>
      <PageHeader
        title="Plan & usage"
        description="Your plan sets how many products, staff seats, locations and domains you can have. Ask the platform operator to change plans."
      />
      {q.isLoading ? (
        <LoadingState />
      ) : q.error || !q.data ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <Card title={`${q.data.plan.name} plan`}>
          {q.data.plan.description && <p className="uc-muted">{q.data.plan.description}</p>}
          <UsageTable usage={q.data} timeZone={context.tenant.timezone} />
        </Card>
      )}
    </>
  );
}
