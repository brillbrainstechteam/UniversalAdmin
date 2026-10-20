import { currencyMinorUnits, formatMinor } from '@uc/contracts';
import type { Tx } from './client';
import { customerMessages } from './b2c-schema';

/** Why nothing is delivered yet: there is no e-mail/SMS connector until Phase 11. */
export const MESSAGE_NOT_SENT_REASON =
  'No e-mail connector is configured yet; this message was recorded, not delivered';

export type MessageTemplate =
  | 'order_confirmed'
  | 'order_shipped'
  | 'order_delivered'
  | 'return_requested'
  | 'return_approved'
  | 'return_rejected'
  | 'return_received'
  | 'refund_succeeded';

/**
 * Records a transactional message to the order's contact (Phase 09, ADR-024). Status is always `not_sent` in this
 * build — the record exists so staff and customers can see what would be sent, never as proof of delivery.
 */
export async function recordCustomerMessage(
  tx: Tx,
  input: {
    tenantId: string;
    order: { id: string; number: string; currency: string; contact: unknown; customerId: string | null };
    template: MessageTemplate;
    detail?: string | null;
    amountMinor?: bigint | null;
    now?: Date;
  },
): Promise<void> {
  const contact = input.order.contact as { email?: string; name?: string } | null;
  if (!contact?.email) return;
  const n = input.order.number;
  const cur = input.order.currency;
  const amount =
    input.amountMinor !== undefined && input.amountMinor !== null
      ? `${cur} ${formatMinor(input.amountMinor.toString(), currencyMinorUnits(cur))}`
      : '';
  const subjects: Record<MessageTemplate, string> = {
    order_confirmed: `Order ${n} confirmed`,
    order_shipped: `Order ${n} has shipped`,
    order_delivered: `Order ${n} was delivered`,
    return_requested: `Return request received for order ${n}`,
    return_approved: `Your return for order ${n} is approved`,
    return_rejected: `Your return for order ${n} was not approved`,
    return_received: `We received your return for order ${n}`,
    refund_succeeded: `Refund of ${amount} for order ${n}`,
  };
  const subject = subjects[input.template];
  await tx.insert(customerMessages).values({
    tenantId: input.tenantId,
    orderId: input.order.id,
    customerId: input.order.customerId,
    recipient: contact.email,
    channel: 'email',
    template: input.template,
    subject,
    body: [`Hello ${contact.name ?? ''},`.trim(), subject + '.', input.detail ?? '']
      .filter(Boolean)
      .join('\n\n'),
    status: 'not_sent',
    statusReason: MESSAGE_NOT_SENT_REASON,
    createdAt: input.now ?? new Date(),
  });
}
