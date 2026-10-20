import { Injectable } from '@nestjs/common';
import {
  CONNECTORS,
  type PilotChecklist,
  type PilotStep,
  type SetupChecklist,
  type SetupStep,
} from '@uc/contracts';
import {
  catalogImportBatches,
  channelDomains,
  channels,
  connections,
  fieldMappings,
  invitations,
  locations,
  memberships,
  metalRates,
  orders,
  outboundCommands,
  products,
  reconciliationIssues,
  syncCheckpoints,
  syncJobs,
  tenants,
  type Tx,
} from '@uc/db';
import { and, count, eq, gt, inArray, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { Errors } from '../../common/errors';
import type { TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';

async function has(tx: Tx, table: PgTable, where: SQL | undefined): Promise<number> {
  const [r] = await tx.select({ n: count() }).from(table).where(where);
  return Number(r?.n ?? 0);
}

/** Setup and pilot checklists computed from real records (Phase 12): nothing is ticked by hand. */
@Injectable()
export class ChecklistsService {
  constructor(private readonly db: DbService) {}

  async setup(ctx: TenantState): Promise<SetupChecklist> {
    const t = ctx.tenantId;
    const features = new Set(ctx.features);
    return this.db.tenant(t, async (tx) => {
      const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, t));
      if (!tenant) throw Errors.notFound('Tenant');
      const activeLocations = await has(
        tx,
        locations,
        and(eq(locations.tenantId, t), eq(locations.status, 'active')),
      );
      const activeChannels = await has(
        tx,
        channels,
        and(eq(channels.tenantId, t), eq(channels.status, 'active')),
      );
      const members = await has(
        tx,
        memberships,
        and(eq(memberships.tenantId, t), eq(memberships.status, 'active')),
      );
      const pendingInvites = await has(
        tx,
        invitations,
        and(
          eq(invitations.tenantId, t),
          eq(invitations.status, 'pending'),
          gt(invitations.expiresAt, new Date()),
        ),
      );
      const activeProducts = await has(
        tx,
        products,
        and(eq(products.tenantId, t), eq(products.status, 'active')),
      );
      const approvedRates = await has(
        tx,
        metalRates,
        and(eq(metalRates.tenantId, t), eq(metalRates.status, 'approved')),
      );
      const verifiedDomains = await has(
        tx,
        channelDomains,
        and(eq(channelDomains.tenantId, t), eq(channelDomains.status, 'verified')),
      );
      const conns = await has(tx, connections, eq(connections.tenantId, t));
      const imports = await has(
        tx,
        catalogImportBatches,
        and(eq(catalogImportBatches.tenantId, t), eq(catalogImportBatches.status, 'committed')),
      );
      const orderCount = await has(tx, orders, eq(orders.tenantId, t));

      const steps: SetupStep[] = [
        {
          key: 'business_profile',
          title: 'Complete the business profile',
          detail: 'Legal name, contact e-mail and phone appear on documents and storefront contact pages.',
          done: Boolean(tenant.legalName && tenant.contactEmail && tenant.contactPhone),
          optional: false,
          link: '/settings/general',
        },
        {
          key: 'location',
          title: 'Add a stock location',
          detail: `${activeLocations} active location(s).`,
          done: activeLocations > 0,
          optional: false,
          link: '/settings/locations',
        },
        {
          key: 'store_channel',
          title: 'Check stores and sales channels',
          detail: `${activeChannels} active channel(s).`,
          done: activeChannels > 0,
          optional: false,
          link: '/settings/stores',
        },
        {
          key: 'staff',
          title: 'Invite your team',
          detail: `${members} member(s), ${pendingInvites} pending invitation(s).`,
          done: members > 1 || pendingInvites > 0,
          optional: true,
          link: '/settings/staff',
        },
        {
          key: 'products',
          title: 'Publish products',
          detail: `${activeProducts} active product(s).`,
          done: activeProducts > 0,
          optional: false,
          link: '/products',
        },
      ];
      if (features.has('metal_rates'))
        steps.push({
          key: 'metal_rates',
          title: 'Approve metal rates',
          detail: `${approvedRates} approved rate(s). Rates are entered and approved by staff; no live feed is connected.`,
          done: approvedRates > 0,
          optional: false,
          link: '/rates',
        });
      if (features.has('payments'))
        steps.push({
          key: 'payments',
          title: 'Connect a payment gateway',
          detail:
            'Only the sandbox gateway is available: a real gateway needs a provider account and keys (blocked). ' +
            'Orders can still be taken on account or as quotations.',
          done: false,
          optional: true,
          link: '/integrations',
        });
      if (features.has('online_store'))
        steps.push({
          key: 'domain',
          title: 'Verify a storefront domain',
          detail: `${verifiedDomains} verified domain(s).`,
          done: verifiedDomains > 0,
          optional: true,
          link: '/online-store',
        });
      if (features.has('integrations'))
        steps.push({
          key: 'catalog_source',
          title: 'Import your catalog or connect your ERP',
          detail: `${imports} committed import(s), ${conns} connection(s).`,
          done: imports > 0 || conns > 0,
          optional: true,
          link: '/integrations',
        });
      steps.push({
        key: 'first_order',
        title: 'Place a test order',
        detail: `${orderCount} order(s) so far.`,
        done: orderCount > 0,
        optional: false,
        link: '/orders',
      });
      const required = steps.filter((s) => !s.optional);
      return {
        steps,
        requiredDone: required.filter((s) => s.done).length,
        requiredTotal: required.length,
        generatedAt: new Date().toISOString(),
      };
    });
  }

  /** Pilot readiness of one connection (spec 05 wizard order). Production support is never claimed here. */
  async pilot(ctx: TenantState, connectionId: string): Promise<PilotChecklist> {
    const t = ctx.tenantId;
    return this.db.tenant(t, async (tx) => {
      const [conn] = await tx
        .select()
        .from(connections)
        .where(and(eq(connections.tenantId, t), eq(connections.id, connectionId)));
      if (!conn) throw Errors.notFound('Connection');
      const def = CONNECTORS[conn.connectorKey];
      const byConn = (
        table: typeof syncJobs | typeof fieldMappings | typeof syncCheckpoints | typeof outboundCommands,
      ) => and(eq(table.tenantId, t), eq(table.connectionId, connectionId));
      const mappings = await has(tx, fieldMappings, byConn(fieldMappings));
      const previews = await has(tx, syncJobs, byConn(syncJobs));
      const committed = await has(
        tx,
        syncJobs,
        and(byConn(syncJobs), inArray(syncJobs.status, ['committed', 'partially_committed'])),
      );
      const checkpoints = await has(tx, syncCheckpoints, byConn(syncCheckpoints));
      const openIssues = await has(
        tx,
        reconciliationIssues,
        and(
          eq(reconciliationIssues.tenantId, t),
          eq(reconciliationIssues.domain, 'integration'),
          eq(reconciliationIssues.status, 'open'),
        ),
      );
      const acked = await has(
        tx,
        outboundCommands,
        and(byConn(outboundCommands), eq(outboundCommands.status, 'acknowledged')),
      );
      const isFile = def?.tier === 'file';
      const ownership = conn.ownership as Record<string, unknown> | null;
      const steps: PilotStep[] = [
        {
          key: 'credentials',
          title: 'Connect and authenticate',
          state:
            isFile || def?.tier === 'simulator' ? 'not_applicable' : conn.credentialRef ? 'done' : 'todo',
          detail: isFile
            ? 'File imports need no credentials.'
            : 'Credentials are stored as a secret reference.',
        },
        {
          key: 'ownership',
          title: 'Assign field ownership',
          state: ownership && Object.keys(ownership).length > 0 ? 'done' : 'todo',
          detail: 'Which system owns price, stock and content fields.',
        },
        {
          key: 'mapping',
          title: 'Review the field mapping',
          state: conn.activeMappingVersion !== null && mappings > 0 ? 'done' : 'todo',
          detail: `${mappings} mapping version(s); active: ${conn.activeMappingVersion ?? 'none'}.`,
        },
        {
          key: 'dry_run',
          title: 'Dry run (preview) a sample',
          state: previews > 0 ? 'done' : 'todo',
          detail: `${previews} sync job(s) previewed or run.`,
        },
        {
          key: 'full_import',
          title: 'Approve and commit the full import',
          state: committed > 0 ? 'done' : 'todo',
          detail: `${committed} committed job(s).`,
        },
        {
          key: 'incremental',
          title: 'Run an incremental sync',
          state: isFile ? 'not_applicable' : committed > 1 || checkpoints > 0 ? 'done' : 'todo',
          detail: isFile ? 'File imports are full snapshots.' : `${checkpoints} checkpoint stream(s).`,
        },
        {
          key: 'reconciliation',
          title: 'Clear reconciliation issues',
          state: committed === 0 ? 'todo' : openIssues === 0 ? 'done' : 'todo',
          detail: `${openIssues} open integration issue(s) for this merchant.`,
        },
        {
          key: 'test_sale',
          title: 'Test sale exported and acknowledged',
          state: isFile ? 'not_applicable' : acked > 0 ? 'done' : 'todo',
          detail: isFile
            ? 'File connectors do not receive orders.'
            : `${acked} order export(s) acknowledged.`,
        },
        {
          key: 'production',
          title: 'Production support',
          state: 'blocked',
          detail:
            def?.status === 'blocked'
              ? 'This vendor connector is not implemented: it needs vendor documentation, a licence and sandbox access.'
              : 'Not certified: a connector is marked production-supported only after sandbox/pilot acceptance with the vendor (spec 05).',
        },
      ];
      return {
        connectionId,
        connectorKey: conn.connectorKey,
        connectorLabel: def?.label ?? conn.connectorKey,
        steps,
        productionSupported: false,
        generatedAt: new Date().toISOString(),
      };
    });
  }
}
