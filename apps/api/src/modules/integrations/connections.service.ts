import { Injectable } from '@nestjs/common';
import {
  BLOCKED_DEPENDENCIES,
  CONNECTORS,
  DEFAULT_OWNERSHIP,
  type Connection,
  type ConnectorCatalog,
  type CreateConnectionRequest,
  type CreateMappingRequest,
  type FieldMapping,
  type MappingPreviewResponse,
  type MappingRule,
  type OutboundCommand,
  type Page,
  type PutDiscoveryRequest,
  type SimulatorFailuresRequest,
  type SimulatorState,
  type TestOrderRequest,
  type UpdateConnectionRequest,
  type ExternalRecordQuery,
  type OutboundListQuery,
} from '@uc/contracts';
import {
  applyMapping,
  describeTick,
  initialSimulatorState,
  stableJson,
  validateRules,
} from '@uc/connector-sdk';
import {
  connections,
  connectorDiscovery,
  enqueueEvent,
  externalRecords,
  fieldMappings,
  outboundCommands,
  products,
  serialItems,
  users,
  variants,
  writeAudit,
  type Tx,
} from '@uc/db';
import { and, asc, desc, eq, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import { decodeCursor, paginate } from '../../common/cursor';
import { AppError, Errors } from '../../common/errors';
import { iso, likePattern } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';
import {
  defaultMapping,
  loadConnection,
  parseOwnership,
  parseSettings,
  requireIntegrations,
  simulatorState,
  toConnection,
  type ConnectionRow,
} from './integrations.common';

@Injectable()
export class ConnectionsService {
  constructor(private readonly db: DbService) {}

  private audit(
    tx: Tx,
    auth: AuthState,
    ctx: TenantState,
    meta: RequestMeta,
    action: string,
    entityType: string,
    entityId: string,
    values: {
      oldValues?: Record<string, unknown>;
      newValues?: Record<string, unknown>;
      reason?: string | null;
    },
  ) {
    return writeAudit(tx, {
      tenantId: ctx.tenantId,
      actorType: 'user',
      actorUserId: auth.userId,
      action,
      entityType,
      entityId,
      oldValues: values.oldValues ?? null,
      newValues: values.newValues ?? null,
      reason: values.reason ?? null,
      correlationId: meta.correlationId,
      ip: meta.ip,
    });
  }

  private async stats(tx: Tx, ctx: TenantState) {
    const issues = await tx.execute<{ connection_id: string; n: number }>(sql`
      select ri.details->>'connectionId' as connection_id, count(*)::int as n from reconciliation_issues ri
      where ri.tenant_id = ${ctx.tenantId} and ri.domain = 'integration' and ri.status = 'open'
      group by 1`);
    const outbound = await tx.execute<{ connection_id: string; pending: number; failed: number }>(sql`
      select oc.connection_id, count(*) filter (where oc.status = 'pending')::int as pending,
             count(*) filter (where oc.status = 'failed')::int as failed
      from outbound_commands oc where oc.tenant_id = ${ctx.tenantId} group by 1`);
    return (id: string) => ({
      openIssues: issues.rows.find((r) => r.connection_id === id)?.n ?? 0,
      pendingOutbound: outbound.rows.find((r) => r.connection_id === id)?.pending ?? 0,
      failedOutbound: outbound.rows.find((r) => r.connection_id === id)?.failed ?? 0,
    });
  }

  private async view(tx: Tx, ctx: TenantState, row: ConnectionRow): Promise<Connection> {
    return toConnection(row, (await this.stats(tx, ctx))(row.id));
  }

  // ---------------------------------------------------------------- catalog + discovery

  async catalog(ctx: TenantState): Promise<ConnectorCatalog> {
    requireIntegrations(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const discovery = await tx
        .select()
        .from(connectorDiscovery)
        .where(eq(connectorDiscovery.tenantId, ctx.tenantId));
      const counts = await tx
        .select({ key: connections.connectorKey, n: sql<number>`count(*)::int` })
        .from(connections)
        .where(and(eq(connections.tenantId, ctx.tenantId), sql`${connections.status} <> 'disconnected'`))
        .groupBy(connections.connectorKey);
      return {
        items: Object.values(CONNECTORS).map((c) => {
          const d = discovery.find((x) => x.connectorKey === c.key);
          return {
            ...c,
            fallback: c.fallback ?? null,
            discovery: d
              ? {
                  status: d.status,
                  answers: d.answers as Record<string, string>,
                  notes: d.notes,
                  version: d.version,
                  updatedAt: iso(d.updatedAt),
                }
              : null,
            connections: counts.find((x) => x.key === c.key)?.n ?? 0,
          };
        }),
        blockedDependencies: BLOCKED_DEPENDENCIES,
      };
    });
  }

  async putDiscovery(
    auth: AuthState,
    ctx: TenantState,
    key: string,
    input: PutDiscoveryRequest,
    meta: RequestMeta,
  ) {
    requireIntegrations(ctx);
    const def = CONNECTORS[key];
    if (!def || def.status !== 'blocked') throw Errors.notFound('Vendor connector');
    await this.db.tenant(ctx.tenantId, async (tx) => {
      const [before] = await tx
        .select()
        .from(connectorDiscovery)
        .where(and(eq(connectorDiscovery.tenantId, ctx.tenantId), eq(connectorDiscovery.connectorKey, key)))
        .for('update');
      if ((before?.version ?? 0) !== input.version) throw Errors.versionConflict(before?.version ?? 0);
      const values = {
        status: input.status,
        answers: input.answers,
        notes: input.notes ?? null,
        updatedBy: auth.userId,
        updatedAt: new Date(),
      };
      if (before) {
        await tx
          .update(connectorDiscovery)
          .set({ ...values, version: before.version + 1 })
          .where(
            and(eq(connectorDiscovery.tenantId, ctx.tenantId), eq(connectorDiscovery.connectorKey, key)),
          );
      } else {
        await tx
          .insert(connectorDiscovery)
          .values({ tenantId: ctx.tenantId, connectorKey: key, ...values, version: 1 });
      }
      await this.audit(tx, auth, ctx, meta, 'connector.discovery_updated', 'connector', key, {
        oldValues: before ? { status: before.status } : {},
        newValues: { status: input.status },
      });
    });
    return this.catalog(ctx);
  }

  // ---------------------------------------------------------------- connections

  async list(ctx: TenantState): Promise<{ items: Connection[] }> {
    requireIntegrations(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(connections)
        .where(eq(connections.tenantId, ctx.tenantId))
        .orderBy(asc(connections.name));
      const stats = await this.stats(tx, ctx);
      return { items: rows.map((r) => toConnection(r, stats(r.id))) };
    });
  }

  async get(ctx: TenantState, id: string): Promise<Connection> {
    requireIntegrations(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => this.view(tx, ctx, await loadConnection(tx, ctx, id)));
  }

  async create(
    auth: AuthState,
    ctx: TenantState,
    input: CreateConnectionRequest,
    meta: RequestMeta,
  ): Promise<Connection> {
    requireIntegrations(ctx);
    const def = CONNECTORS[input.connectorKey];
    if (!def) throw Errors.validation([{ path: 'connectorKey', message: 'Unknown connector' }]);
    if (def.status !== 'available') {
      throw new AppError(
        409,
        'CONNECTOR_UNAVAILABLE',
        `${def.label} is not available yet: it is waiting for vendor documentation and testing. Use CSV / Excel file import meanwhile.`,
        { blockedOn: def.blockedOn, fallback: def.fallback ?? null },
      );
    }
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const settings = parseSettings(input.settings ?? {});
      const ownership = parseOwnership({ ...DEFAULT_OWNERSHIP, ...(input.ownership ?? {}) });
      const [row] = await tx
        .insert(connections)
        .values({
          tenantId: ctx.tenantId,
          connectorKey: def.key,
          name: input.name,
          credentialRef: input.credentialRef ?? null,
          settings,
          ownership,
          adapterState: def.key === 'simulator' ? initialSimulatorState() : {},
          activeMappingVersion: 1,
          createdBy: auth.userId,
        })
        .returning();
      await tx.insert(fieldMappings).values({
        tenantId: ctx.tenantId,
        connectionId: row!.id,
        version: 1,
        rules: defaultMapping(def.key),
        notes: def.key === 'simulator' ? 'Simulator export layout' : 'Generic CSV template',
        createdBy: auth.userId,
      });
      await this.audit(tx, auth, ctx, meta, 'connection.created', 'connection', row!.id, {
        newValues: {
          connectorKey: def.key,
          name: input.name,
          credentialRef: input.credentialRef ?? null,
          ownership,
        },
      });
      return this.view(tx, ctx, row!);
    });
  }

  async update(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: UpdateConnectionRequest,
    meta: RequestMeta,
  ): Promise<Connection> {
    requireIntegrations(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const before = await loadConnection(tx, ctx, id, true);
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      if (before.status === 'disconnected' && input.status && input.status !== 'disconnected') {
        throw new AppError(
          409,
          'INVALID_STATE_TRANSITION',
          'A disconnected connection cannot be reactivated; create a new one',
        );
      }
      const ownership = input.ownership
        ? parseOwnership({ ...parseOwnership(before.ownership), ...input.ownership })
        : undefined;
      const ownershipChanged =
        ownership && stableJson(ownership) !== stableJson(parseOwnership(before.ownership));
      if ((ownershipChanged || input.status === 'disconnected') && !input.reason) {
        throw Errors.validation([
          { path: 'reason', message: 'Give a reason when changing field ownership or disconnecting' },
        ]);
      }
      const [after] = await tx
        .update(connections)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.credentialRef !== undefined ? { credentialRef: input.credentialRef } : {}),
          ...(input.settings
            ? { settings: parseSettings({ ...parseSettings(before.settings), ...input.settings }) }
            : {}),
          ...(ownership ? { ownership } : {}),
          version: before.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(connections.id, id))
        .returning();
      await this.audit(
        tx,
        auth,
        ctx,
        meta,
        input.status === 'disconnected' ? 'connection.disconnected' : 'connection.updated',
        'connection',
        id,
        {
          oldValues: {
            name: before.name,
            status: before.status,
            ownership: before.ownership,
            settings: before.settings,
            credentialRef: before.credentialRef,
          },
          newValues: {
            name: after!.name,
            status: after!.status,
            ownership: after!.ownership,
            settings: after!.settings,
            credentialRef: after!.credentialRef,
          },
          reason: input.reason ?? null,
        },
      );
      return this.view(tx, ctx, after!);
    });
  }

  async testConnection(ctx: TenantState, id: string): Promise<{ ok: boolean; message: string }> {
    requireIntegrations(ctx);
    const row = await this.db.tenant(ctx.tenantId, (tx) => loadConnection(tx, ctx, id));
    if (row.connectorKey === 'file_csv')
      return { ok: true, message: 'File connections need no network connection: upload a file to sync.' };
    if (row.connectorKey === 'simulator')
      return { ok: true, message: 'The simulator is a built-in test double and is always reachable.' };
    return { ok: false, message: 'No adapter available for this connector' };
  }

  // ---------------------------------------------------------------- mappings

  async mappings(ctx: TenantState, connectionId: string): Promise<{ items: FieldMapping[] }> {
    requireIntegrations(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const conn = await loadConnection(tx, ctx, connectionId);
      const rows = await tx
        .select({ m: fieldMappings, by: users.displayName })
        .from(fieldMappings)
        .leftJoin(users, eq(users.id, fieldMappings.createdBy))
        .where(eq(fieldMappings.connectionId, connectionId))
        .orderBy(desc(fieldMappings.version));
      return {
        items: rows.map(({ m, by }) => ({
          id: m.id,
          version: m.version,
          rules: m.rules as MappingRule[],
          notes: m.notes,
          active: m.version === conn.activeMappingVersion,
          createdBy: by,
          createdAt: iso(m.createdAt),
        })),
      };
    });
  }

  async createMapping(
    auth: AuthState,
    ctx: TenantState,
    connectionId: string,
    input: CreateMappingRequest,
    meta: RequestMeta,
  ): Promise<FieldMapping> {
    requireIntegrations(ctx);
    const problems = validateRules(input.rules);
    if (problems.length) {
      throw new AppError(
        400,
        'MAPPING_INVALID',
        'The mapping is incomplete or inconsistent',
        problems.map((p) => ({ path: `rules.${p.field}`, message: p.message })),
      );
    }
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const conn = await loadConnection(tx, ctx, connectionId, true);
      const [last] = await tx
        .select({ v: sql<number>`coalesce(max(${fieldMappings.version}), 0)::int` })
        .from(fieldMappings)
        .where(eq(fieldMappings.connectionId, connectionId));
      const version = (last?.v ?? 0) + 1;
      const [m] = await tx
        .insert(fieldMappings)
        .values({
          tenantId: ctx.tenantId,
          connectionId,
          version,
          rules: input.rules,
          notes: input.notes ?? null,
          createdBy: auth.userId,
        })
        .returning();
      await tx
        .update(connections)
        .set({ activeMappingVersion: version, version: conn.version + 1, updatedAt: new Date() })
        .where(eq(connections.id, connectionId));
      await this.audit(tx, auth, ctx, meta, 'connection.mapping_published', 'connection', connectionId, {
        oldValues: { activeMappingVersion: conn.activeMappingVersion },
        newValues: { activeMappingVersion: version, rules: input.rules.length },
      });
      return {
        id: m!.id,
        version,
        rules: input.rules,
        notes: m!.notes,
        active: true,
        createdBy: auth.displayName,
        createdAt: iso(m!.createdAt),
      };
    });
  }

  previewMapping(
    ctx: TenantState,
    rules: MappingRule[],
    rows: Record<string, string>[],
  ): MappingPreviewResponse {
    requireIntegrations(ctx);
    const problems = validateRules(rules);
    return {
      rows: rows.map((raw) => {
        const r = applyMapping(rules, raw);
        return { record: problems.length ? null : r.record, errors: [...problems, ...r.errors] };
      }),
    };
  }

  // ---------------------------------------------------------------- simulator

  async simulator(ctx: TenantState, connectionId: string): Promise<SimulatorState> {
    requireIntegrations(ctx);
    const row = await this.db.tenant(ctx.tenantId, (tx) => loadConnection(tx, ctx, connectionId));
    if (row.connectorKey !== 'simulator') throw Errors.notFound('Simulator');
    const s = simulatorState(row);
    return {
      tick: s.tick,
      failNext: s.failNext,
      timeoutNext: s.timeoutNext,
      receivedOrders: Object.keys(s.orders).length,
      description: describeTick(s.tick),
    };
  }

  async advanceSimulator(
    auth: AuthState,
    ctx: TenantState,
    connectionId: string,
    meta: RequestMeta,
  ): Promise<SimulatorState> {
    requireIntegrations(ctx);
    await this.db.tenant(ctx.tenantId, async (tx) => {
      const row = await loadConnection(tx, ctx, connectionId, true);
      if (row.connectorKey !== 'simulator') throw Errors.notFound('Simulator');
      const s = simulatorState(row);
      await tx
        .update(connections)
        .set({ adapterState: { ...s, tick: s.tick + 1 }, updatedAt: new Date() })
        .where(eq(connections.id, row.id));
      await this.audit(tx, auth, ctx, meta, 'simulator.advanced', 'connection', row.id, {
        newValues: { tick: s.tick + 1 },
      });
    });
    return this.simulator(ctx, connectionId);
  }

  async simulatorFailures(
    auth: AuthState,
    ctx: TenantState,
    connectionId: string,
    input: SimulatorFailuresRequest,
    meta: RequestMeta,
  ) {
    requireIntegrations(ctx);
    await this.db.tenant(ctx.tenantId, async (tx) => {
      const row = await loadConnection(tx, ctx, connectionId, true);
      if (row.connectorKey !== 'simulator') throw Errors.notFound('Simulator');
      await tx
        .update(connections)
        .set({ adapterState: { ...simulatorState(row), ...input }, updatedAt: new Date() })
        .where(eq(connections.id, row.id));
      await this.audit(tx, auth, ctx, meta, 'simulator.failures_set', 'connection', row.id, {
        newValues: input,
      });
    });
    return this.simulator(ctx, connectionId);
  }

  // ---------------------------------------------------------------- outbound (order export)

  async createTestOrder(
    auth: AuthState,
    ctx: TenantState,
    connectionId: string,
    input: TestOrderRequest,
    meta: RequestMeta,
  ): Promise<{ command: OutboundCommand; created: boolean }> {
    requireIntegrations(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const conn = await loadConnection(tx, ctx, connectionId);
      if (!CONNECTORS[conn.connectorKey]?.capabilities.pushOrders) {
        throw new AppError(
          409,
          'CONNECTOR_UNAVAILABLE',
          `${CONNECTORS[conn.connectorKey]?.label ?? conn.connectorKey} cannot receive orders`,
        );
      }
      if (conn.status !== 'active')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', `Connection is ${conn.status}`);
      const payload = { kind: 'test_order', lines: input.lines };
      const inserted = await tx
        .insert(outboundCommands)
        .values({
          tenantId: ctx.tenantId,
          connectionId,
          kind: 'push_order',
          reference: input.reference,
          payload,
          nextAttemptAt: new Date(),
          createdBy: auth.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (!inserted[0]) {
        const [existing] = await tx
          .select()
          .from(outboundCommands)
          .where(
            and(
              eq(outboundCommands.connectionId, connectionId),
              eq(outboundCommands.reference, input.reference),
            ),
          );
        if (stableJson(existing!.payload) !== stableJson(payload)) {
          throw new AppError(
            422,
            'IDEMPOTENCY_KEY_REUSED',
            'This order reference was already sent with different lines',
          );
        }
        return { command: toCommand(existing!), created: false };
      }
      await enqueueEvent(tx, {
        tenantId: ctx.tenantId,
        eventType: 'OrderExportRequested',
        aggregateType: 'outbound_command',
        aggregateId: inserted[0].id,
        correlationId: meta.correlationId,
        payload: { reference: input.reference, connectionId },
      });
      await this.audit(
        tx,
        auth,
        ctx,
        meta,
        'outbound.test_order_queued',
        'outbound_command',
        inserted[0].id,
        {
          newValues: { reference: input.reference, lines: input.lines.length },
        },
      );
      return { command: toCommand(inserted[0]), created: true };
    });
  }

  async outbound(ctx: TenantState, q: OutboundListQuery): Promise<Page<OutboundCommand>> {
    requireIntegrations(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const where: (SQL | undefined)[] = [
        eq(outboundCommands.tenantId, ctx.tenantId),
        q.connectionId ? eq(outboundCommands.connectionId, q.connectionId) : undefined,
        q.status ? eq(outboundCommands.status, q.status) : undefined,
      ];
      if (cursor) {
        const at = new Date(String(cursor.sortValue));
        where.push(
          or(
            lt(outboundCommands.createdAt, at),
            and(eq(outboundCommands.createdAt, at), lt(outboundCommands.id, cursor.id)),
          ),
        );
      }
      const rows = await tx
        .select()
        .from(outboundCommands)
        .where(and(...where))
        .orderBy(desc(outboundCommands.createdAt), desc(outboundCommands.id))
        .limit(q.limit + 1);
      return paginate(rows.map(toCommand), q.limit, (r) => r.createdAt);
    });
  }

  async retryOutbound(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    meta: RequestMeta,
  ): Promise<OutboundCommand> {
    requireIntegrations(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [cmd] = await tx
        .select()
        .from(outboundCommands)
        .where(and(eq(outboundCommands.tenantId, ctx.tenantId), eq(outboundCommands.id, id)))
        .for('update');
      if (!cmd) throw Errors.notFound('Outbound command');
      if (cmd.status !== 'failed')
        throw new AppError(
          409,
          'INVALID_STATE_TRANSITION',
          `Only failed commands can be retried (this one is ${cmd.status})`,
        );
      const [after] = await tx
        .update(outboundCommands)
        .set({ status: 'pending', attempts: 0, nextAttemptAt: new Date() })
        .where(eq(outboundCommands.id, id))
        .returning();
      await this.audit(tx, auth, ctx, meta, 'outbound.retried', 'outbound_command', id, {
        oldValues: { status: 'failed', lastError: cmd.lastError },
        newValues: { status: 'pending' },
      });
      return toCommand(after!);
    });
  }

  // ---------------------------------------------------------------- external records

  async records(ctx: TenantState, connectionId: string, q: ExternalRecordQuery) {
    requireIntegrations(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await loadConnection(tx, ctx, connectionId);
      const where: (SQL | undefined)[] = [
        eq(externalRecords.tenantId, ctx.tenantId),
        eq(externalRecords.connectionId, connectionId),
      ];
      if (q.q) where.push(ilike(externalRecords.externalId, likePattern(q.q)));
      if (cursor) where.push(sql`${externalRecords.externalId} > ${String(cursor.sortValue)}`);
      const rows = await tx
        .select({
          r: externalRecords,
          sku: variants.sku,
          productTitle: products.title,
          tag: serialItems.serialTag,
        })
        .from(externalRecords)
        .leftJoin(
          variants,
          and(eq(externalRecords.internalType, 'variant'), eq(variants.id, externalRecords.internalId)),
        )
        .leftJoin(products, eq(products.id, variants.productId))
        .leftJoin(
          serialItems,
          and(
            eq(externalRecords.internalType, 'serial_item'),
            eq(serialItems.id, externalRecords.internalId),
          ),
        )
        .where(and(...where))
        .orderBy(asc(externalRecords.externalId))
        .limit(q.limit + 1);
      return paginate(
        rows.map(({ r, sku, productTitle, tag }) => ({
          id: r.internalId,
          recordType: r.recordType,
          externalId: r.externalId,
          internalType: r.internalType,
          internalId: r.internalId,
          label:
            r.internalType === 'variant' ? `${sku ?? '?'} · ${productTitle ?? ''}` : `Piece ${tag ?? '?'}`,
          externalVersion: r.externalVersion,
          sourceTimestamp: r.sourceTimestamp ? iso(r.sourceTimestamp) : null,
          deletedAt: r.deletedAt ? iso(r.deletedAt) : null,
          updatedAt: iso(r.updatedAt),
        })),
        q.limit,
        (r) => r.externalId,
      );
    });
  }
}

export function toCommand(c: typeof outboundCommands.$inferSelect): OutboundCommand {
  return {
    id: c.id,
    connectionId: c.connectionId,
    kind: c.kind,
    reference: c.reference,
    status: c.status,
    attempts: c.attempts,
    nextAttemptAt: c.nextAttemptAt ? iso(c.nextAttemptAt) : null,
    lastError: c.lastError,
    externalRef: c.externalRef,
    payload: c.payload as Record<string, unknown>,
    createdAt: iso(c.createdAt),
    acknowledgedAt: c.acknowledgedAt ? iso(c.acknowledgedAt) : null,
  };
}
