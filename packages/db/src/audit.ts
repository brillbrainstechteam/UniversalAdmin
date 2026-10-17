import type { Executor } from './client';
import { redact } from './redact';
import { auditEvents } from './schema';

export interface AuditInput {
  tenantId: string | null;
  actorType: 'user' | 'platform' | 'system';
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  reason?: string | null;
  correlationId?: string | null;
  ip?: string | null;
}

/** Append an audit event in the caller's transaction. Values are redacted before persistence (ADR-008). */
export async function writeAudit(tx: Executor, input: AuditInput): Promise<void> {
  await tx.insert(auditEvents).values({
    tenantId: input.tenantId,
    actorType: input.actorType,
    actorUserId: input.actorUserId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    oldValues: input.oldValues ? redact(input.oldValues) : null,
    newValues: input.newValues ? redact(input.newValues) : null,
    reason: input.reason ?? null,
    correlationId: input.correlationId ?? null,
    ip: input.ip ?? null,
  });
}
