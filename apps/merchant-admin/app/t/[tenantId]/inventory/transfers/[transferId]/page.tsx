'use client';

import type { Transfer } from '@uc/contracts';
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  ForbiddenState,
  LoadingState,
  PageHeader,
  StatusBadge,
  errorMessage,
  formatDateTime,
} from '@uc/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { InventoryTabs, qtyText, useInventoryAction } from '../../../../../../lib/inventory';
import { useTenant, useTenantQuery } from '../../../../../../lib/tenant';

export default function TransferPage() {
  const { transferId } = useParams<{ transferId: string }>();
  const { can, tenantId, context, api } = useTenant();
  const enabled = can('inventory.read') && context.features.includes('inventory');
  const tz = context.tenant.timezone;
  const t = useTenantQuery<Transfer>(
    ['inventory', 'transfer', transferId],
    `/v1/admin/inventory/transfers/${transferId}`,
    undefined,
    enabled,
  );
  const [confirm, setConfirm] = useState<'receive' | 'cancel' | null>(null);
  const act = useInventoryAction(
    (input: { action: 'receive' | 'cancel'; note: string }) =>
      api<Transfer>(`/v1/admin/inventory/transfers/${transferId}/${input.action}`, {
        method: 'POST',
        body: { version: t.data!.version, note: input.note || undefined },
      }),
    (r) => `Transfer ${r.number} ${r.status}`,
    () => setConfirm(null),
  );
  if (!enabled) return <ForbiddenState />;
  if (t.isLoading) return <LoadingState />;
  if (t.error) return <ErrorState error={t.error} onRetry={() => void t.refetch()} />;
  const x = t.data!;
  const canTransfer = can('inventory.transfer') && x.status === 'in_transit';
  return (
    <>
      <PageHeader
        title={`Transfer ${x.number}`}
        description={
          <>
            {x.from.name} → {x.to.name} · <StatusBadge status={x.status} />
          </>
        }
        actions={
          canTransfer && (
            <>
              <Button variant="primary" onClick={() => setConfirm('receive')}>
                Receive at {x.to.name}
              </Button>
              <Button variant="danger" onClick={() => setConfirm('cancel')}>
                Cancel transfer
              </Button>
            </>
          )
        }
      />
      <InventoryTabs />
      <Card title="Details">
        <dl className="uc-form-grid">
          <div>
            <dt className="uc-muted">Dispatched</dt>
            <dd>
              {formatDateTime(x.createdAt, tz)} by {x.createdBy?.name ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="uc-muted">Received</dt>
            <dd>
              {x.receivedAt ? `${formatDateTime(x.receivedAt, tz)} by ${x.receivedBy?.name ?? '—'}` : '—'}
            </dd>
          </div>
          <div>
            <dt className="uc-muted">Note</dt>
            <dd>{x.note ?? '—'}</dd>
          </div>
          <div>
            <dt className="uc-muted">Ledger</dt>
            <dd>
              <Link href={`/t/${tenantId}/inventory/movements?reference=${encodeURIComponent(x.number)}`}>
                Movements with reference {x.number}
              </Link>
            </dd>
          </div>
        </dl>
      </Card>
      <Card title="Lines">
        <DataTable
          caption="Transfer lines"
          rows={x.lines}
          rowKey={(l) => `${l.variantId}-${l.serialItem?.id ?? ''}`}
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
            { key: 'product', header: 'Product', render: (l) => l.productTitle },
            {
              key: 'qty',
              header: 'Quantity / piece',
              render: (l) =>
                l.serialItem ? (
                  <span className="uc-mono">{l.serialItem.serialTag}</span>
                ) : (
                  qtyText(l.quantity)
                ),
            },
          ]}
        />
      </Card>
      {act.error && !confirm && <Alert tone="danger">{errorMessage(act.error)}</Alert>}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm === 'receive' ? `Receive ${x.number}` : `Cancel ${x.number}`}
        description={
          confirm === 'receive'
            ? `All lines become sellable stock at ${x.to.name}.`
            : `All lines return to sellable stock at ${x.from.name}.`
        }
        confirmLabel={confirm === 'receive' ? 'Receive' : 'Cancel transfer'}
        tone={confirm === 'receive' ? 'primary' : 'danger'}
        loading={act.isPending}
        error={act.error ? errorMessage(act.error) : null}
        onConfirm={(note) => act.mutate({ action: confirm!, note })}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}
