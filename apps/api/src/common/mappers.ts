import type { Address, AuditEvent, Channel, ChannelType, Location, Store, ThemeTokens } from '@uc/contracts';
import type { auditEvents, channelDomains, channels, locations, stores } from '@uc/db';

type StoreRow = typeof stores.$inferSelect;
type ChannelRow = typeof channels.$inferSelect;
type DomainRow = typeof channelDomains.$inferSelect;
type LocationRow = typeof locations.$inferSelect;
type AuditRow = typeof auditEvents.$inferSelect;

export const iso = (d: Date) => d.toISOString();

export function toStore(row: StoreRow): Store {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    defaultCurrency: row.defaultCurrency,
    timezone: row.timezone,
    version: row.version,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toChannel(row: ChannelRow, domains: DomainRow[]): Channel {
  return {
    id: row.id,
    storeId: row.storeId,
    code: row.code,
    name: row.name,
    type: row.type as ChannelType,
    status: row.status,
    theme: row.theme as ThemeTokens,
    domains: domains
      .filter((d) => d.channelId === row.id)
      .map((d) => ({ hostname: d.hostname, status: d.status, isPrimary: d.isPrimary })),
    version: row.version,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toLocation(row: LocationRow): Location {
  return {
    id: row.id,
    storeId: row.storeId,
    parentId: row.parentId,
    code: row.code,
    name: row.name,
    type: row.type,
    status: row.status,
    address: (row.address as Address | null) ?? null,
    version: row.version,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toAuditEvent(row: AuditRow, actorEmail: string | null): AuditEvent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    actorType: row.actorType,
    actor: row.actorUserId && actorEmail ? { id: row.actorUserId, email: actorEmail } : null,
    reason: row.reason,
    oldValues: (row.oldValues as Record<string, unknown> | null) ?? null,
    newValues: (row.newValues as Record<string, unknown> | null) ?? null,
    correlationId: row.correlationId,
    createdAt: iso(row.createdAt),
  };
}

/** Escape LIKE wildcards in user search input. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
