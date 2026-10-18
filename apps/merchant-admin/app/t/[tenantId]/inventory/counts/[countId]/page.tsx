'use client';

import type { StockCount } from '@uc/contracts';
import {
  Alert,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  StatusBadge,
  formatDateTime,
} from '@uc/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { InventoryTabs, qtyText } from '../../../../../../lib/inventory';
import { useTenant, useTenantQuery } from '../../../../../../lib/tenant';

export default function CountPage() {
  const { countId } = useParams<{ countId: string }>();
  const { can, tenantId, context } = useTenant();
  const enabled = can('inventory.read') && context.features.includes('inventory');
  const tz = context.tenant.timezone;
  const c = useTenantQuery<StockCount>(
    ['inventory', 'count', countId],
    `/v1/admin/inventory/counts/${countId}`,
    undefined,
    enabled,
  );
  if (!enabled) return <ForbiddenState />;
  if (c.isLoading) return <LoadingState />;
  if (c.error) return <ErrorState error={c.error} onRetry={() => void c.refetch()} />;
  const x = c.data!;
  return (
    <>
      <PageHeader
        title={`Stocktake · ${x.location.name}`}
        description={
          <>
            Counted {formatDateTime(x.asOf, tz)} · <StatusBadge status={x.status} /> · by{' '}
            {x.createdBy?.name ?? '—'}
          </>
        }
      />
      <InventoryTabs />
      {x.status === 'rejected_stale' && (
        <Alert tone="warning" title="Not applied: stale count">
          A count taken later for this location was already applied, so this older snapshot was recorded but
          did not change stock.
          {x.issueId && (
            <>
              {' '}
              <Link href={`/t/${tenantId}/inventory/issues`}>Review the reconciliation issue</Link>.
            </>
          )}
        </Alert>
      )}
      {x.status === 'applied' && (
        <Card>
          <Link href={`/t/${tenantId}/inventory/movements?operationId=${x.operationId}`}>
            Variance movements in the ledger
          </Link>
        </Card>
      )}
      <Card title="Lines">
        <DataTable
          caption="Count lines"
          rows={x.lines}
          rowKey={(l) => l.variantId}
          empty={<EmptyState title="No lines" description="" />}
          columns={[
            {
              key: 'sku',
              header: 'SKU',
              render: (l) => (
                <Link href={`/t/${tenantId}/inventory/variants/${l.variantId}`} className="uc-mono">
                  {l.sku}
                </Link>
              ),
            },
            { key: 'counted', header: 'Counted', render: (l) => qtyText(l.counted) },
            { key: 'expected', header: 'System before count', render: (l) => qtyText(l.expected) },
            {
              key: 'variance',
              header: 'Variance',
              render: (l) =>
                l.variance.startsWith('-') ? `−${qtyText(l.variance.slice(1))}` : `+${qtyText(l.variance)}`,
            },
          ]}
        />
      </Card>
    </>
  );
}
