import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  CONNECTORS,
  compareGrams,
  computeFine,
  qty,
  qtyAdd,
  qtyCmp,
  qtyIsZero,
  qtySub,
  type CanonicalRecord,
  type CommitJobRequest,
  type FilePreviewRequest,
  type JobCounts,
  type MappingRule,
  type Page,
  type ReconciliationIssue,
  type ResolveDiscrepancyRequest,
  type SyncJob,
  type SyncJobListQuery,
  type SyncJobRow,
  type SyncJobRowQuery,
} from '@uc/contracts';
import {
  FileFormatError,
  applyMapping,
  parseTabular,
  simulatorAdapter,
  stableJson,
  type SourceRow,
} from '@uc/connector-sdk';
import {
  acknowledgedCommitments,
  connections,
  enqueueEvent,
  externalRecords,
  fieldMappings,
  locations,
  openIssue,
  postMovements,
  products,
  purityDefinitions,
  reconciliationIssues,
  serialItems,
  setSerialState,
  stockBalances,
  stockCountLines,
  stockCounts,
  stockMovements,
  syncCheckpoints,
  syncJobRows,
  syncJobs,
  users,
  variants,
  variantStockSettings,
  writeAudit,
  type Tx,
} from '@uc/db';
import { and, asc, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { decodeCursor, paginate } from '../../common/cursor';
import { AppError, Errors } from '../../common/errors';
import { iso } from '../../common/mappers';
import type { AuthState, RequestMeta, TenantState } from '../../common/request';
import { DbService } from '../../db/db.service';
import { issueQuery, toIssue } from '../inventory/inventory.common';
import { loadSettings } from '../jewellery/jewellery.service';
import {
  loadConnection,
  parseOwnership,
  parseSettings,
  requireIntegrations,
  requireUnscoped,
  simulatorState,
  type ConnectionRow,
} from './integrations.common';

type JobRow = typeof syncJobs.$inferSelect;
type StagedRow = typeof syncJobRows.$inferSelect;
type ExternalRow = typeof externalRecords.$inferSelect;
type RowError = { field: string; message: string };

const EMPTY_COUNTS: JobCounts = {
  total: 0,
  create: 0,
  update: 0,
  unchanged: 0,
  stale: 0,
  delete: 0,
  error: 0,
  applied: 0,
};
const MAX_FILE_BYTES = 2_400_000;
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const key = (type: string, externalId: string) => `${type}:${externalId}`;

class RowFailure extends Error {
  constructor(readonly errors: RowError[]) {
    super(errors.map((e) => e.message).join('; '));
  }
}

/** true when the incoming record is older than what was last applied (out-of-order delivery). */
function isOlder(rec: CanonicalRecord, ex: ExternalRow): boolean {
  if (
    rec.version &&
    ex.externalVersion &&
    /^\d{1,18}$/.test(rec.version) &&
    /^\d{1,18}$/.test(ex.externalVersion)
  ) {
    return BigInt(rec.version) < BigInt(ex.externalVersion);
  }
  if (rec.updatedAt && ex.sourceTimestamp)
    return new Date(rec.updatedAt).getTime() < ex.sourceTimestamp.getTime();
  return false;
}

function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'item';
}

@Injectable()
export class SyncService {
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

  private async activeRules(tx: Tx, conn: ConnectionRow): Promise<{ version: number; rules: MappingRule[] }> {
    if (!conn.activeMappingVersion)
      throw new AppError(409, 'MAPPING_INVALID', 'Publish a field mapping first');
    const [m] = await tx
      .select()
      .from(fieldMappings)
      .where(
        and(eq(fieldMappings.connectionId, conn.id), eq(fieldMappings.version, conn.activeMappingVersion)),
      );
    if (!m) throw new AppError(409, 'MAPPING_INVALID', 'The active mapping version is missing');
    return { version: m.version, rules: m.rules as MappingRule[] };
  }

  private usable(conn: ConnectionRow) {
    if (conn.status !== 'active') {
      throw new AppError(
        409,
        'INVALID_STATE_TRANSITION',
        `This connection is ${conn.status}; activate it to sync`,
      );
    }
  }

  // ---------------------------------------------------------------- preview (staging)

  async previewFile(
    auth: AuthState,
    ctx: TenantState,
    connectionId: string,
    input: FilePreviewRequest,
    meta: RequestMeta,
  ): Promise<SyncJob> {
    requireIntegrations(ctx);
    requireUnscoped(ctx);
    const bytes = Buffer.from(input.contentBase64, 'base64');
    if (bytes.length === 0)
      throw Errors.validation([{ path: 'contentBase64', message: 'The file is empty' }]);
    if (bytes.length > MAX_FILE_BYTES)
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Files are limited to 2.4 MB (split larger exports)');
    let table: Awaited<ReturnType<typeof parseTabular>>;
    try {
      table = await parseTabular(input.fileName, bytes);
    } catch (e) {
      if (e instanceof FileFormatError) throw new AppError(400, 'FILE_FORMAT_INVALID', e.message);
      throw e;
    }
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const conn = await loadConnection(tx, ctx, connectionId, true);
      this.usable(conn);
      if (conn.connectorKey !== 'file_csv') {
        throw new AppError(
          409,
          'CONNECTOR_UNAVAILABLE',
          'Only file connections accept uploads; pull from the source instead',
        );
      }
      return this.stage(
        tx,
        auth,
        ctx,
        conn,
        table.rows,
        {
          source: 'file',
          fileName: input.fileName,
          fileSha256: sha256(bytes),
          asOf: null,
          cursorFrom: null,
          cursorTo: null,
        },
        meta,
      );
    });
  }

  async pull(auth: AuthState, ctx: TenantState, connectionId: string, meta: RequestMeta): Promise<SyncJob> {
    requireIntegrations(ctx);
    requireUnscoped(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const conn = await loadConnection(tx, ctx, connectionId, true);
      this.usable(conn);
      if (conn.connectorKey !== 'simulator') {
        throw new AppError(
          409,
          'CONNECTOR_UNAVAILABLE',
          `${CONNECTORS[conn.connectorKey]?.label ?? conn.connectorKey} cannot be pulled; upload a file`,
        );
      }
      const [checkpoint] = await tx
        .select()
        .from(syncCheckpoints)
        .where(and(eq(syncCheckpoints.connectionId, conn.id), eq(syncCheckpoints.stream, 'items')));
      const state = { ...simulatorState(conn), pieces: ctx.features.includes('serialized_items') };
      const pulled = await simulatorAdapter.pullItems!(state, checkpoint?.cursor ?? null);
      return this.stage(
        tx,
        auth,
        ctx,
        conn,
        pulled.rows,
        {
          source: 'simulator',
          fileName: null,
          fileSha256: null,
          asOf: pulled.asOf,
          cursorFrom: checkpoint?.cursor ?? null,
          cursorTo: pulled.cursor,
        },
        meta,
      );
    });
  }

  /**
   * Maps and validates every source row against the tenant's data and the connection's dedupe map, and stores the
   * outcome per row. Nothing outside the staging tables is written; commit applies it later.
   */
  private async stage(
    tx: Tx,
    auth: AuthState,
    ctx: TenantState,
    conn: ConnectionRow,
    rows: SourceRow[],
    source: {
      source: 'file' | 'simulator';
      fileName: string | null;
      fileSha256: string | null;
      asOf: string | null;
      cursorFrom: string | null;
      cursorTo: string | null;
    },
    meta: RequestMeta,
  ): Promise<SyncJob> {
    const settings = parseSettings(conn.settings);
    const { version, rules } = await this.activeRules(tx, conn);
    const mapped = rows.map((r) => ({
      row: r,
      ...applyMapping(rules, r.values, {
        productType: settings.defaultProductType,
        location: settings.defaultLocationCode,
      }),
    }));
    const records = mapped.flatMap((m) => (m.record ? [m.record] : []));

    const locs = await tx.select().from(locations).where(eq(locations.tenantId, ctx.tenantId));
    const locByCode = new Map(locs.map((l) => [l.code.toLowerCase(), l]));
    const purities = await tx
      .select()
      .from(purityDefinitions)
      .where(eq(purityDefinitions.tenantId, ctx.tenantId));
    const purityByCode = new Map(purities.map((p) => [p.code.toUpperCase(), p]));
    const existing = await tx.select().from(externalRecords).where(eq(externalRecords.connectionId, conn.id));
    const exByKey = new Map(existing.map((e) => [key(e.recordType, e.externalId), e]));
    const mappedVariants = new Map(
      existing.filter((e) => e.internalType === 'variant').map((e) => [e.internalId, e]),
    );
    const lowerSkus = [...new Set(records.map((r) => r.sku.toLowerCase()))];
    const skuRows = lowerSkus.length
      ? await tx
          .select({ id: variants.id, sku: variants.sku })
          .from(variants)
          .where(and(eq(variants.tenantId, ctx.tenantId), inArray(sql`lower(${variants.sku})`, lowerSkus)))
      : [];
    const variantBySku = new Map(skuRows.map((v) => [v.sku.toLowerCase(), v]));
    const lowerTags = [...new Set(records.flatMap((r) => (r.tag ? [r.tag.toLowerCase()] : [])))];
    const tagRows = lowerTags.length
      ? await tx
          .select({ id: serialItems.id, tag: serialItems.serialTag })
          .from(serialItems)
          .where(
            and(
              eq(serialItems.tenantId, ctx.tenantId),
              inArray(sql`lower(${serialItems.serialTag})`, lowerTags),
            ),
          )
      : [];
    const itemByTag = new Map(tagRows.map((t) => [t.tag.toLowerCase(), t]));
    const pieceIds = new Set(
      existing.filter((e) => e.internalType === 'serial_item').map((e) => e.internalId),
    );
    const designSkusInBatch = new Set(
      mapped.flatMap((m) =>
        m.record && m.record.recordType === 'design' && !m.errors.length ? [m.record.sku.toLowerCase()] : [],
      ),
    );
    const jewelleryOk = ctx.features.includes('jewellery');
    const piecesOk = ctx.features.includes('serialized_items');
    const jSettings = jewelleryOk ? await loadSettings(tx, ctx.tenantId) : null;

    const seen = new Map<string, number>();
    const counts: JobCounts = { ...EMPTY_COUNTS };
    const staged: (typeof syncJobRows.$inferInsert)[] = [];
    const jobId = randomUUID();
    let latest: string | null = null;

    for (const m of mapped) {
      const errors: RowError[] = [...m.errors];
      const rec = m.record;
      let action: StagedRow['action'] = 'error';
      if (rec) {
        const k = key(rec.recordType, rec.externalId);
        const dup = seen.get(k);
        if (dup !== undefined)
          errors.push({
            field: 'externalId',
            message: `Duplicate external ID in this batch (first seen on row ${dup})`,
          });
        seen.set(k, m.row.rowNo);
        const loc = rec.location ? locByCode.get(rec.location.toLowerCase()) : undefined;
        if (rec.location && !loc)
          errors.push({ field: 'location', message: `Unknown location code "${rec.location}"` });
        else if (loc && loc.status !== 'active')
          errors.push({ field: 'location', message: `Location ${loc.code} is inactive` });
        if (rec.recordType === 'design' && rec.quantity !== null && !rec.location) {
          errors.push({
            field: 'location',
            message: 'Stock quantity needs a location (or set a default location on the connection)',
          });
        }
        if (rec.productType === 'jewellery' && !jewelleryOk)
          errors.push({ field: 'productType', message: 'Jewellery is not enabled for this merchant' });
        if (rec.recordType === 'piece') {
          if (!piecesOk)
            errors.push({
              field: 'recordType',
              message: 'Serialized pieces are not enabled for this merchant',
            });
          if (rec.purity && !purityByCode.has(rec.purity))
            errors.push({ field: 'purity', message: `Unknown purity code "${rec.purity}"` });
          if (rec.grossG && rec.netG && compareGrams(rec.netG, rec.grossG) > 0) {
            errors.push({
              field: 'netWeight',
              message: 'Net weight exceeds gross weight; correct it in the source system',
            });
          }
          if (rec.huid && jSettings?.huidFormat === 'bis_6_alnum' && !/^[A-Z0-9]{6}$/.test(rec.huid)) {
            errors.push({ field: 'huid', message: 'HUID must be 6 letters/digits' });
          }
          const parentKnown =
            designSkusInBatch.has(rec.sku.toLowerCase()) || variantBySku.has(rec.sku.toLowerCase());
          if (!parentKnown)
            errors.push({
              field: 'sku',
              message: `Design "${rec.sku}" not found: include its design row or create the product first`,
            });
          const owner = itemByTag.get((rec.tag ?? '').toLowerCase());
          const ex = exByKey.get(k);
          if (owner && (!ex || ex.internalId !== owner.id) && !pieceIds.has(owner.id)) {
            errors.push({
              field: 'tag',
              message: `Tag ${rec.tag} already belongs to a piece not linked to this connection`,
            });
          }
        } else {
          const v = variantBySku.get(rec.sku.toLowerCase());
          const ex = exByKey.get(k);
          if (
            v &&
            (!ex || ex.internalId !== v.id) &&
            !mappedVariants.has(v.id) &&
            !settings.linkExistingBySku
          ) {
            errors.push({
              field: 'sku',
              message: `SKU ${rec.sku} belongs to a product that is not linked to this connection (enable "link existing products by SKU" to adopt it)`,
            });
          } else if (
            v &&
            mappedVariants.has(v.id) &&
            mappedVariants.get(v.id)!.externalId !== rec.externalId
          ) {
            errors.push({
              field: 'sku',
              message: `SKU ${rec.sku} is already linked to external ID ${mappedVariants.get(v.id)!.externalId}`,
            });
          }
        }
        if (!errors.length) {
          const ex = exByKey.get(k);
          const checksum = sha256(stableJson(rec));
          if (rec.deleted) action = ex && !ex.deletedAt ? 'delete' : 'unchanged';
          else if (!ex) action = 'create';
          else if (isOlder(rec, ex)) action = 'stale';
          else if (ex.checksum === checksum && !ex.deletedAt) action = 'unchanged';
          else action = 'update';
          if (rec.updatedAt && action !== 'stale' && (!latest || rec.updatedAt > latest))
            latest = rec.updatedAt;
          staged.push({
            tenantId: ctx.tenantId,
            jobId,
            rowNo: m.row.rowNo,
            externalId: rec.externalId,
            action,
            errors,
            raw: m.row.values,
            record: rec,
            checksum,
          });
        }
      }
      if (errors.length) {
        action = 'error';
        staged.push({
          tenantId: ctx.tenantId,
          jobId,
          rowNo: m.row.rowNo,
          externalId: rec?.externalId ?? null,
          action,
          errors,
          raw: m.row.values,
          record: rec,
          checksum: null,
        });
      }
      counts[action]++;
      counts.total++;
    }

    const asOf = new Date(source.asOf ?? latest ?? new Date().toISOString());
    await tx.insert(syncJobs).values({
      id: jobId,
      tenantId: ctx.tenantId,
      connectionId: conn.id,
      source: source.source,
      status: 'previewed',
      mappingVersion: version,
      fileName: source.fileName,
      fileSha256: source.fileSha256,
      cursorFrom: source.cursorFrom,
      cursorTo: source.cursorTo,
      snapshotAsOf: asOf,
      counts,
      createdBy: auth.userId,
    });
    for (let i = 0; i < staged.length; i += 500)
      await tx.insert(syncJobRows).values(staged.slice(i, i + 500));
    await tx.update(connections).set({ lastSyncAt: new Date() }).where(eq(connections.id, conn.id));
    await this.audit(tx, auth, ctx, meta, 'integration.import_previewed', 'sync_job', jobId, {
      newValues: { connectionId: conn.id, source: source.source, fileName: source.fileName, counts },
    });
    return this.loadJob(tx, ctx, jobId);
  }

  // ---------------------------------------------------------------- reads

  private jobQuery(tx: Tx) {
    return tx
      .select({ j: syncJobs, connectionName: connections.name, by: users.displayName })
      .from(syncJobs)
      .innerJoin(connections, eq(connections.id, syncJobs.connectionId))
      .leftJoin(users, eq(users.id, syncJobs.createdBy));
  }

  private toJob(r: { j: JobRow; connectionName: string; by: string | null }): SyncJob {
    const j = r.j;
    return {
      id: j.id,
      connectionId: j.connectionId,
      connectionName: r.connectionName,
      source: j.source,
      status: j.status,
      mappingVersion: j.mappingVersion,
      fileName: j.fileName,
      cursorFrom: j.cursorFrom,
      cursorTo: j.cursorTo,
      snapshotAsOf: iso(j.snapshotAsOf),
      counts: { ...EMPTY_COUNTS, ...(j.counts as Partial<JobCounts>) },
      stockResult: (j.stockResult as SyncJob['stockResult']) ?? null,
      error: j.error,
      createdBy: r.by,
      createdAt: iso(j.createdAt),
      committedAt: j.committedAt ? iso(j.committedAt) : null,
    };
  }

  private async loadJob(tx: Tx, ctx: TenantState, id: string): Promise<SyncJob> {
    const [row] = await this.jobQuery(tx).where(
      and(eq(syncJobs.tenantId, ctx.tenantId), eq(syncJobs.id, id)),
    );
    if (!row) throw Errors.notFound('Sync job');
    return this.toJob(row);
  }

  async jobs(ctx: TenantState, q: SyncJobListQuery): Promise<Page<SyncJob>> {
    requireIntegrations(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const where: (SQL | undefined)[] = [
        eq(syncJobs.tenantId, ctx.tenantId),
        q.connectionId ? eq(syncJobs.connectionId, q.connectionId) : undefined,
      ];
      if (cursor) {
        const at = new Date(String(cursor.sortValue));
        where.push(
          or(lt(syncJobs.createdAt, at), and(eq(syncJobs.createdAt, at), lt(syncJobs.id, cursor.id))),
        );
      }
      const rows = await this.jobQuery(tx)
        .where(and(...where))
        .orderBy(desc(syncJobs.createdAt), desc(syncJobs.id))
        .limit(q.limit + 1);
      return paginate(
        rows.map((r) => this.toJob(r)),
        q.limit,
        (r) => r.createdAt,
      );
    });
  }

  async job(ctx: TenantState, id: string): Promise<SyncJob> {
    requireIntegrations(ctx);
    return this.db.tenant(ctx.tenantId, (tx) => this.loadJob(tx, ctx, id));
  }

  async rows(ctx: TenantState, id: string, q: SyncJobRowQuery): Promise<Page<SyncJobRow>> {
    requireIntegrations(ctx);
    const cursor = decodeCursor(q.cursor);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await this.loadJob(tx, ctx, id);
      const where: (SQL | undefined)[] = [
        eq(syncJobRows.jobId, id),
        q.action ? eq(syncJobRows.action, q.action) : undefined,
      ];
      if (cursor) where.push(sql`${syncJobRows.rowNo} > ${cursor.sortValue as number}`);
      const rows = await tx
        .select()
        .from(syncJobRows)
        .where(and(...where))
        .orderBy(asc(syncJobRows.rowNo))
        .limit(q.limit + 1);
      const page = paginate(rows, q.limit, (r) => r.rowNo);
      return {
        items: page.items.map((r) => ({
          rowNo: r.rowNo,
          externalId: r.externalId,
          action: r.action,
          applied: r.applied === 'yes',
          errors: r.errors as RowError[],
          record: (r.record as CanonicalRecord | null) ?? null,
          raw: r.raw as Record<string, unknown>,
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  /** Rows with errors as CSV (original columns + error text) so the source data can be fixed and re-uploaded. */
  async errorsCsv(ctx: TenantState, id: string): Promise<{ fileName: string; csv: string }> {
    requireIntegrations(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const job = await this.loadJob(tx, ctx, id);
      const rows = await tx
        .select()
        .from(syncJobRows)
        .where(and(eq(syncJobRows.jobId, id), eq(syncJobRows.action, 'error')))
        .orderBy(asc(syncJobRows.rowNo));
      const columns = [...new Set(rows.flatMap((r) => Object.keys(r.raw as Record<string, unknown>)))];
      const esc = (v: unknown) => {
        const s = v === null || v === undefined ? '' : String(v);
        // Neutralise spreadsheet formulas (CSV injection) and quote everything.
        const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
        return `"${safe.replace(/"/g, '""')}"`;
      };
      const lines = [
        ['row', ...columns, 'errors'].map(esc).join(','),
        ...rows.map((r) =>
          [
            r.rowNo,
            ...columns.map((c) => (r.raw as Record<string, unknown>)[c]),
            (r.errors as RowError[]).map((e) => `${e.field}: ${e.message}`).join(' | '),
          ]
            .map(esc)
            .join(','),
        ),
      ];
      return { fileName: `sync-errors-${job.id.slice(0, 8)}.csv`, csv: `${lines.join('\r\n')}\r\n` };
    });
  }

  // ---------------------------------------------------------------- commit

  async discard(auth: AuthState, ctx: TenantState, id: string, meta: RequestMeta): Promise<SyncJob> {
    requireIntegrations(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [job] = await tx
        .select()
        .from(syncJobs)
        .where(and(eq(syncJobs.tenantId, ctx.tenantId), eq(syncJobs.id, id)))
        .for('update');
      if (!job) throw Errors.notFound('Sync job');
      if (job.status !== 'previewed')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', `This job is already ${job.status}`);
      await tx.update(syncJobs).set({ status: 'discarded' }).where(eq(syncJobs.id, id));
      await this.audit(tx, auth, ctx, meta, 'integration.import_discarded', 'sync_job', id, {});
      return this.loadJob(tx, ctx, id);
    });
  }

  async commit(
    auth: AuthState,
    ctx: TenantState,
    id: string,
    input: CommitJobRequest,
    meta: RequestMeta,
  ): Promise<SyncJob> {
    requireIntegrations(ctx);
    requireUnscoped(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [job] = await tx
        .select()
        .from(syncJobs)
        .where(and(eq(syncJobs.tenantId, ctx.tenantId), eq(syncJobs.id, id)))
        .for('update');
      if (!job) throw Errors.notFound('Sync job');
      if (job.status !== 'previewed')
        throw new AppError(409, 'INVALID_STATE_TRANSITION', `This job is already ${job.status}`);
      const conn = await loadConnection(tx, ctx, job.connectionId, true);
      this.usable(conn);
      const counts = { ...EMPTY_COUNTS, ...(job.counts as Partial<JobCounts>) };
      if (input.mode === 'atomic' && counts.error > 0) {
        throw new AppError(
          409,
          'IMPORT_HAS_ERRORS',
          `${counts.error} row(s) have errors: fix them, or commit only the valid rows (partial)`,
          {
            errors: counts.error,
          },
        );
      }
      const ownership = parseOwnership(conn.ownership);
      const settings = parseSettings(conn.settings);
      const staged = await tx
        .select()
        .from(syncJobRows)
        .where(and(eq(syncJobRows.jobId, id), inArray(syncJobRows.action, ['create', 'update', 'delete'])))
        .orderBy(asc(syncJobRows.rowNo));
      // Designs before pieces, so a piece can attach to a design created in the same batch.
      const ordered = [
        ...staged.filter((r) => (r.record as CanonicalRecord).recordType === 'design'),
        ...staged.filter((r) => (r.record as CanonicalRecord).recordType === 'piece'),
      ];
      const pieceSkus = new Set(
        staged.flatMap((r) =>
          (r.record as CanonicalRecord).recordType === 'piece'
            ? [(r.record as CanonicalRecord).sku.toLowerCase()]
            : [],
        ),
      );
      const locs = await tx.select().from(locations).where(eq(locations.tenantId, ctx.tenantId));
      const locByCode = new Map(locs.map((l) => [l.code.toLowerCase(), l]));
      const purities = await tx
        .select()
        .from(purityDefinitions)
        .where(eq(purityDefinitions.tenantId, ctx.tenantId));
      const jSettings = ctx.features.includes('jewellery') ? await loadSettings(tx, ctx.tenantId) : null;
      const plan = {
        snapshot: [] as {
          variantId: string;
          externalId: string;
          locationId: string;
          locationCode: string;
          counted: string;
          sku: string;
        }[],
        receipts: [] as { pieceId: string; variantId: string; locationId: string; tag: string }[],
      };
      // One external-record lookup for the whole job (an external ID appears at most once per job: duplicates
      // are row errors at staging).
      const exByKey = new Map<string, ExternalRow>();
      for (let i = 0; i < ordered.length; i += 1000) {
        const ids = ordered.slice(i, i + 1000).map((r) => (r.record as CanonicalRecord).externalId);
        const found = await tx
          .select()
          .from(externalRecords)
          .where(and(eq(externalRecords.connectionId, conn.id), inArray(externalRecords.externalId, ids)));
        for (const e of found) exByKey.set(`${e.recordType}:${e.externalId}`, e);
      }
      const ctxApply = {
        tx,
        ctx,
        auth,
        conn,
        ownership,
        settings,
        pieceSkus,
        locByCode,
        purities,
        jSettings,
        job,
        plan,
        meta,
        exByKey,
      };

      const appliedIds = await this.bulkCreateDesigns(ctxApply, ordered);
      const bulkApplied = new Set(appliedIds);
      let applied = appliedIds.length;
      for (const row of ordered) {
        if (bulkApplied.has(row.id)) continue;
        try {
          if (input.mode === 'partial') {
            await tx.transaction(async (sp) => this.applyRow({ ...ctxApply, tx: sp }, row));
          } else {
            await this.applyRow(ctxApply, row);
          }
          applied++;
          appliedIds.push(row.id);
        } catch (e) {
          const errors: RowError[] =
            e instanceof RowFailure
              ? e.errors
              : [
                  {
                    field: 'row',
                    message: (e as { cause?: { constraint?: string } }).cause?.constraint
                      ? `Conflicts with existing data (${(e as { cause: { constraint: string } }).cause.constraint})`
                      : 'Could not be applied',
                  },
                ];
          if (input.mode === 'atomic') {
            throw new AppError(
              409,
              'IMPORT_HAS_ERRORS',
              `Row ${row.rowNo} could not be applied: ${errors.map((x) => x.message).join('; ')}`,
              {
                rowNo: row.rowNo,
                errors,
              },
            );
          }
          await tx.update(syncJobRows).set({ action: 'error', errors }).where(eq(syncJobRows.id, row.id));
          counts[row.action]--;
          counts.error++;
        }
      }
      counts.applied = applied;
      for (let i = 0; i < appliedIds.length; i += 1000) {
        await tx
          .update(syncJobRows)
          .set({ applied: 'yes' })
          .where(inArray(syncJobRows.id, appliedIds.slice(i, i + 1000)));
      }

      const stockResult = await this.applyStock(ctxApply);
      const failed = counts.error > 0;
      const now = new Date();
      await tx
        .update(syncJobs)
        .set({ status: failed ? 'partially_committed' : 'committed', counts, stockResult, committedAt: now })
        .where(eq(syncJobs.id, id));
      await tx
        .update(connections)
        .set({ lastSyncAt: now, lastSuccessAt: now, updatedAt: now })
        .where(eq(connections.id, conn.id));
      if (job.cursorTo) {
        // Monotonic checkpoint: never move backwards.
        await tx
          .insert(syncCheckpoints)
          .values({
            tenantId: ctx.tenantId,
            connectionId: conn.id,
            stream: 'items',
            cursor: job.cursorTo,
            sourceTimestamp: job.snapshotAsOf,
            jobId: id,
          })
          .onConflictDoUpdate({
            target: [syncCheckpoints.connectionId, syncCheckpoints.stream],
            set: { cursor: job.cursorTo, sourceTimestamp: job.snapshotAsOf, jobId: id, updatedAt: now },
            setWhere: sql`${syncCheckpoints.sourceTimestamp} is null or ${syncCheckpoints.sourceTimestamp} <= ${job.snapshotAsOf}`,
          });
      }
      await enqueueEvent(tx, {
        tenantId: ctx.tenantId,
        eventType: 'SyncJobCompleted',
        aggregateType: 'sync_job',
        aggregateId: id,
        correlationId: meta.correlationId,
        payload: { connectionId: conn.id, counts, stockResult, mode: input.mode },
      });
      await this.audit(tx, auth, ctx, meta, 'integration.import_committed', 'sync_job', id, {
        newValues: { connectionId: conn.id, mode: input.mode, counts, stockResult },
      });
      return this.loadJob(tx, ctx, id);
    });
  }

  /**
   * Fast path for the common initial import: designs that are new to this connection and whose SKU is unused
   * are created with a handful of multi-row statements instead of ~8 queries per row. Runs in a savepoint;
   * if anything fails, nothing from it remains and those rows go through the per-row path, which reports
   * exact row errors. Returns the IDs of the staged rows it applied.
   */
  private async bulkCreateDesigns(
    c: Parameters<SyncService['applyRow']>[0],
    ordered: StagedRow[],
  ): Promise<string[]> {
    const { ctx, conn } = c;
    const designs = ordered.filter((r) => {
      const rec = r.record as CanonicalRecord;
      return (
        r.action === 'create' && rec.recordType === 'design' && !c.exByKey.has(`design:${rec.externalId}`)
      );
    });
    const skuCount = new Map<string, number>();
    for (const r of designs) {
      const k = (r.record as CanonicalRecord).sku.toLowerCase();
      skuCount.set(k, (skuCount.get(k) ?? 0) + 1);
    }
    let candidates = designs.filter(
      (r) => skuCount.get((r.record as CanonicalRecord).sku.toLowerCase()) === 1,
    );
    if (candidates.length < 2) return [];
    const taken = new Set<string>();
    for (let i = 0; i < candidates.length; i += 1000) {
      const skus = candidates.slice(i, i + 1000).map((r) => (r.record as CanonicalRecord).sku.toLowerCase());
      const found = await c.tx
        .select({ sku: variants.sku })
        .from(variants)
        .where(and(eq(variants.tenantId, ctx.tenantId), inArray(sql`lower(${variants.sku})`, skus)));
      for (const f of found) taken.add(f.sku.toLowerCase());
    }
    // Existing SKUs need the link-or-reject decision of the per-row path.
    candidates = candidates.filter((r) => !taken.has((r.record as CanonicalRecord).sku.toLowerCase()));
    if (candidates.length < 2) return [];

    const bases = [
      ...new Set(
        candidates.map((r) =>
          slugify((r.record as CanonicalRecord).title ?? (r.record as CanonicalRecord).sku),
        ),
      ),
    ];
    const usedSlugs = new Set<string>();
    for (let i = 0; i < bases.length; i += 1000) {
      const chunk = bases.slice(i, i + 1000);
      const arr = sql`array[${sql.join(
        chunk.map((b) => sql`${b}`),
        sql`, `,
      )}]::text[]`;
      const rows = await c.tx
        .select({ slug: products.slug })
        .from(products)
        .where(
          and(
            eq(products.tenantId, ctx.tenantId),
            sql`(${products.slug} = any(${arr}) or regexp_replace(${products.slug}, '-[0-9]+$', '') = any(${arr}))`,
          ),
        );
      for (const r of rows) usedSlugs.add(r.slug);
    }
    const planned = candidates.map((row) => {
      const rec = row.record as CanonicalRecord;
      const base = slugify(rec.title ?? rec.sku);
      let slug = base;
      for (let n = 2; usedSlugs.has(slug); n++) slug = `${base}-${n}`;
      usedSlugs.add(slug);
      return { row, rec, slug, serial: c.pieceSkus.has(rec.sku.toLowerCase()), variantId: '' };
    });

    const now = new Date();
    try {
      await c.tx.transaction(async (sp) => {
        for (let i = 0; i < planned.length; i += 500) {
          const chunk = planned.slice(i, i + 500);
          const ps = await sp
            .insert(products)
            .values(
              chunk.map((p) => ({
                tenantId: ctx.tenantId,
                title: p.rec.title ?? p.rec.sku,
                slug: p.slug,
                productType: p.rec.productType,
                status: 'draft' as const,
                createdBy: c.auth.userId,
              })),
            )
            .returning({ id: products.id, slug: products.slug });
          const productBySlug = new Map(ps.map((p) => [p.slug, p.id]));
          const vs = await sp
            .insert(variants)
            .values(
              chunk.map((p) => ({
                tenantId: ctx.tenantId,
                productId: productBySlug.get(p.slug)!,
                sku: p.rec.sku,
              })),
            )
            .returning({ id: variants.id, sku: variants.sku });
          const variantBySku = new Map(vs.map((v) => [v.sku.toLowerCase(), v.id]));
          await sp.insert(variantStockSettings).values(
            chunk.map((p) => ({
              tenantId: ctx.tenantId,
              variantId: variantBySku.get(p.rec.sku.toLowerCase())!,
              tracking: p.serial ? ('serial' as const) : ('quantity' as const),
              unit: p.serial ? ('pcs' as const) : p.rec.unit,
              version: 1,
            })),
          );
          await sp.insert(externalRecords).values(
            chunk.map((p) => ({
              tenantId: ctx.tenantId,
              connectionId: conn.id,
              recordType: 'design' as const,
              externalId: p.rec.externalId,
              internalType: 'variant' as const,
              internalId: variantBySku.get(p.rec.sku.toLowerCase())!,
              externalVersion: p.rec.version,
              sourceTimestamp: p.rec.updatedAt ? new Date(p.rec.updatedAt) : null,
              checksum: p.row.checksum!,
              lastJobId: c.job.id,
              updatedAt: now,
            })),
          );
          for (const p of chunk) p.variantId = variantBySku.get(p.rec.sku.toLowerCase())!;
        }
      });
    } catch {
      // Deliberate fallback, not a swallowed error: the per-row path re-applies these rows and reports each failure.
      return [];
    }
    for (const p of planned) {
      const loc = p.rec.location ? c.locByCode.get(p.rec.location.toLowerCase()) : undefined;
      if (p.rec.quantity !== null && loc) {
        c.plan.snapshot.push({
          variantId: p.variantId,
          externalId: p.rec.externalId,
          locationId: loc.id,
          locationCode: loc.code,
          counted: p.rec.quantity,
          sku: p.rec.sku,
        });
      }
    }
    return planned.map((p) => p.row.id);
  }

  private async applyRow(
    c: {
      tx: Tx;
      ctx: TenantState;
      auth: AuthState;
      conn: ConnectionRow;
      ownership: ReturnType<typeof parseOwnership>;
      settings: ReturnType<typeof parseSettings>;
      pieceSkus: Set<string>;
      locByCode: Map<string, typeof locations.$inferSelect>;
      purities: (typeof purityDefinitions.$inferSelect)[];
      jSettings: Awaited<ReturnType<typeof loadSettings>> | null;
      job: JobRow;
      plan: {
        snapshot: {
          variantId: string;
          externalId: string;
          locationId: string;
          locationCode: string;
          counted: string;
          sku: string;
        }[];
        receipts: { pieceId: string; variantId: string; locationId: string; tag: string }[];
      };
      meta: RequestMeta;
      exByKey: Map<string, ExternalRow>;
    },
    row: StagedRow,
  ): Promise<void> {
    const { tx, ctx, conn, ownership } = c;
    const rec = row.record as CanonicalRecord;
    const ex = c.exByKey.get(`${rec.recordType}:${rec.externalId}`);
    const now = new Date();
    const track = {
      externalVersion: rec.version,
      sourceTimestamp: rec.updatedAt ? new Date(rec.updatedAt) : null,
      checksum: row.checksum!,
      lastJobId: c.job.id,
      updatedAt: now,
    };

    if (row.action === 'delete') {
      if (!ex) return;
      await tx
        .update(externalRecords)
        .set({ ...track, deletedAt: now })
        .where(
          and(
            eq(externalRecords.connectionId, conn.id),
            eq(externalRecords.recordType, rec.recordType),
            eq(externalRecords.externalId, rec.externalId),
          ),
        );
      await openIssue(tx, {
        tenantId: ctx.tenantId,
        domain: 'integration',
        kind: 'erp_record_deleted',
        severity: 'warning',
        variantId: ex.internalType === 'variant' ? ex.internalId : null,
        dedupeKey: `erp-deleted:${conn.id}:${rec.recordType}:${rec.externalId}`,
        correlationId: c.meta.correlationId,
        details: {
          connectionId: conn.id,
          jobId: c.job.id,
          recordType: rec.recordType,
          externalId: rec.externalId,
          sku: rec.sku,
          tag: rec.tag,
          message:
            'Deleted or sold in the source system. Nothing was deleted here: archive the product or write the piece off if appropriate.',
        },
      });
      return;
    }

    const loc = rec.location ? c.locByCode.get(rec.location.toLowerCase()) : undefined;

    if (rec.recordType === 'design') {
      let variantId: string;
      if (ex) {
        variantId = ex.internalId;
        const [v] = await tx.select().from(variants).where(eq(variants.id, variantId));
        if (!v) throw new RowFailure([{ field: 'sku', message: 'The linked variant no longer exists' }]);
        if (ownership.title === 'erp' && rec.title) {
          await tx
            .update(products)
            .set({ title: rec.title, updatedAt: now })
            .where(eq(products.id, v.productId));
        }
        if (ownership.sku === 'erp' && rec.sku !== v.sku) {
          await tx
            .update(variants)
            .set({ sku: rec.sku, updatedAt: now, version: sql`${variants.version} + 1` })
            .where(eq(variants.id, v.id));
        }
        await tx
          .update(externalRecords)
          .set({ ...track, deletedAt: null })
          .where(
            and(
              eq(externalRecords.connectionId, conn.id),
              eq(externalRecords.recordType, 'design'),
              eq(externalRecords.externalId, rec.externalId),
            ),
          );
      } else {
        const [existingVariant] = await tx
          .select()
          .from(variants)
          .where(
            and(eq(variants.tenantId, ctx.tenantId), sql`lower(${variants.sku}) = ${rec.sku.toLowerCase()}`),
          );
        if (existingVariant) {
          if (!c.settings.linkExistingBySku) {
            throw new RowFailure([
              {
                field: 'sku',
                message: `SKU ${rec.sku} now belongs to a product not linked to this connection`,
              },
            ]);
          }
          variantId = existingVariant.id;
        } else {
          const base = slugify(rec.title ?? rec.sku);
          const taken = await tx
            .select({ slug: products.slug })
            .from(products)
            .where(and(eq(products.tenantId, ctx.tenantId), sql`${products.slug} like ${`${base}%`}`));
          const used = new Set(taken.map((t) => t.slug));
          let slug = base;
          for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
          const [p] = await tx
            .insert(products)
            .values({
              tenantId: ctx.tenantId,
              title: rec.title ?? rec.sku,
              slug,
              productType: rec.productType,
              status: 'draft',
              createdBy: c.auth.userId,
            })
            .returning({ id: products.id });
          const [v] = await tx
            .insert(variants)
            .values({ tenantId: ctx.tenantId, productId: p!.id, sku: rec.sku })
            .returning({ id: variants.id });
          variantId = v!.id;
          await tx.insert(variantStockSettings).values({
            tenantId: ctx.tenantId,
            variantId,
            tracking: c.pieceSkus.has(rec.sku.toLowerCase()) ? 'serial' : 'quantity',
            unit: c.pieceSkus.has(rec.sku.toLowerCase()) ? 'pcs' : rec.unit,
            version: 1,
          });
        }
        await tx.insert(externalRecords).values({
          tenantId: ctx.tenantId,
          connectionId: conn.id,
          recordType: 'design',
          externalId: rec.externalId,
          internalType: 'variant',
          internalId: variantId,
          ...track,
        });
      }
      if (rec.quantity !== null && loc) {
        c.plan.snapshot.push({
          variantId,
          externalId: rec.externalId,
          locationId: loc.id,
          locationCode: loc.code,
          counted: rec.quantity,
          sku: rec.sku,
        });
      }
      return;
    }

    // ---- piece
    const [parent] = await tx
      .select()
      .from(variants)
      .where(
        and(eq(variants.tenantId, ctx.tenantId), sql`lower(${variants.sku}) = ${rec.sku.toLowerCase()}`),
      );
    if (!parent) throw new RowFailure([{ field: 'sku', message: `Design ${rec.sku} does not exist` }]);
    const purity = c.purities.find((p) => p.code.toUpperCase() === rec.purity);
    if (!purity) throw new RowFailure([{ field: 'purity', message: `Unknown purity ${rec.purity}` }]);
    const fine = computeFine({ netG: rec.netG!, fineness: purity.fineness }, c.jSettings?.fineScale ?? 3);
    const measurements = {
      grossG: rec.grossG!,
      netG: rec.netG!,
      stoneG: rec.stoneG ?? '0.000000',
      fineG: fine.fineG,
      fineSource: 'computed' as const,
      fineFormula: fine.formula,
      metal: purity.metal,
      purityId: purity.id,
    };
    let pieceId: string;
    if (ex) {
      pieceId = ex.internalId;
      const [item] = await tx.select().from(serialItems).where(eq(serialItems.id, pieceId));
      if (!item) throw new RowFailure([{ field: 'tag', message: 'The linked piece no longer exists' }]);
      if (c.ownership.weights === 'erp' && item.status !== 'retired') {
        const changed =
          item.grossG !== measurements.grossG ||
          item.netG !== measurements.netG ||
          item.stoneG !== measurements.stoneG ||
          item.purityId !== purity.id;
        if (changed || (rec.huid && rec.huid !== item.huid)) {
          await tx
            .update(serialItems)
            .set({
              ...measurements,
              ...(rec.huid ? { huid: rec.huid } : {}),
              updatedBy: c.auth.userId,
              updatedAt: now,
              version: item.version + 1,
            })
            .where(eq(serialItems.id, pieceId));
          await writeAudit(tx, {
            tenantId: ctx.tenantId,
            actorType: 'user',
            actorUserId: c.auth.userId,
            action: 'serial_item.measurements_synced',
            entityType: 'serial_item',
            entityId: pieceId,
            oldValues: { grossG: item.grossG, netG: item.netG, stoneG: item.stoneG, huid: item.huid },
            newValues: {
              grossG: measurements.grossG,
              netG: measurements.netG,
              stoneG: measurements.stoneG,
              huid: rec.huid,
            },
            reason: `ERP sync ${conn.name} (job ${c.job.id})`,
            correlationId: c.meta.correlationId,
            ip: c.meta.ip,
          });
        }
      }
      if (loc && item.stockState === 'in_stock' && item.locationId !== loc.id) {
        await openIssue(tx, {
          tenantId: ctx.tenantId,
          domain: 'integration',
          kind: 'erp_piece_conflict',
          severity: 'warning',
          variantId: item.variantId,
          locationId: item.locationId,
          dedupeKey: `erp-piece-location:${conn.id}:${pieceId}`,
          correlationId: c.meta.correlationId,
          details: {
            connectionId: conn.id,
            tag: item.serialTag,
            erpLocation: loc.code,
            message:
              'The source system shows this piece at another location. Transfer it, or correct the source.',
          },
        });
      } else if (loc && item.stockState === 'not_received' && c.ownership.pieces === 'erp') {
        c.plan.receipts.push({ pieceId, variantId: item.variantId, locationId: loc.id, tag: item.serialTag });
      }
      await tx
        .update(externalRecords)
        .set({ ...track, deletedAt: null })
        .where(
          and(
            eq(externalRecords.connectionId, conn.id),
            eq(externalRecords.recordType, 'piece'),
            eq(externalRecords.externalId, rec.externalId),
          ),
        );
      return;
    }
    const [settingsRow] = await tx
      .select()
      .from(variantStockSettings)
      .where(
        and(eq(variantStockSettings.tenantId, ctx.tenantId), eq(variantStockSettings.variantId, parent.id)),
      );
    if (!settingsRow) {
      await tx.insert(variantStockSettings).values({
        tenantId: ctx.tenantId,
        variantId: parent.id,
        tracking: 'serial',
        unit: 'pcs',
        version: 1,
      });
    } else if (settingsRow.tracking !== 'serial') {
      const [history] = await tx
        .select({ id: stockMovements.id })
        .from(stockMovements)
        .where(eq(stockMovements.variantId, parent.id))
        .limit(1);
      if (history)
        throw new RowFailure([
          {
            field: 'sku',
            message: `${parent.sku} is tracked by quantity with stock history; pieces cannot be added to it`,
          },
        ]);
      await tx
        .update(variantStockSettings)
        .set({ tracking: 'serial', unit: 'pcs', version: settingsRow.version + 1 })
        .where(
          and(eq(variantStockSettings.tenantId, ctx.tenantId), eq(variantStockSettings.variantId, parent.id)),
        );
    }
    const [item] = await tx
      .insert(serialItems)
      .values({
        tenantId: ctx.tenantId,
        variantId: parent.id,
        serialTag: rec.tag!,
        huid: rec.huid,
        ...measurements,
        status: 'active',
        raw: { source: 'erp', connectionId: conn.id, externalId: rec.externalId, input: row.raw },
        createdBy: c.auth.userId,
        updatedBy: c.auth.userId,
      })
      .returning({ id: serialItems.id });
    pieceId = item!.id;
    await tx.insert(externalRecords).values({
      tenantId: ctx.tenantId,
      connectionId: conn.id,
      recordType: 'piece',
      externalId: rec.externalId,
      internalType: 'serial_item',
      internalId: pieceId,
      ...track,
    });
    if (loc && c.ownership.pieces === 'erp')
      c.plan.receipts.push({ pieceId, variantId: parent.id, locationId: loc.id, tag: rec.tag! });
  }

  /**
   * Applies the ERP stock picture through the inventory ledger: piece receipts, then one snapshot per location
   * (`stock_counts` source erp). A snapshot older than the last applied ERP snapshot for that location is recorded
   * as stale and changes nothing; a quantity below current holds is reported, never forced.
   */
  private async applyStock(c: {
    tx: Tx;
    ctx: TenantState;
    auth: AuthState;
    conn: ConnectionRow;
    ownership: ReturnType<typeof parseOwnership>;
    job: JobRow;
    plan: {
      snapshot: {
        variantId: string;
        externalId: string;
        locationId: string;
        locationCode: string;
        counted: string;
        sku: string;
      }[];
      receipts: { pieceId: string; variantId: string; locationId: string; tag: string }[];
    };
    meta: RequestMeta;
  }): Promise<SyncJob['stockResult']> {
    const { tx, ctx, conn, job, plan } = c;
    const result = { locations: 0, movements: 0, stale: 0, issues: 0, addedBack: '0' };
    if (plan.receipts.length) {
      const moves = await postMovements(tx, {
        tenantId: ctx.tenantId,
        type: 'receipt',
        reference: `ERP:${job.id}:pieces`,
        note: `ERP sync ${conn.name}`,
        actorUserId: c.auth.userId,
        correlationId: c.meta.correlationId,
        lines: plan.receipts.map((r) => ({
          variantId: r.variantId,
          locationId: r.locationId,
          condition: 'sellable' as const,
          onHand: '1',
          serialItemId: r.pieceId,
          label: r.tag,
        })),
      });
      const piecesByLocation = new Map<string, string[]>();
      for (const r of plan.receipts)
        piecesByLocation.set(r.locationId, [...(piecesByLocation.get(r.locationId) ?? []), r.pieceId]);
      for (const [locationId, ids] of piecesByLocation)
        await setSerialState(tx, ctx.tenantId, ids, ['not_received'], 'in_stock', locationId);
      result.movements += moves.length;
    }
    if (c.ownership.stock !== 'erp' || plan.snapshot.length === 0) return result;

    const byLocation = new Map<string, typeof plan.snapshot>();
    for (const s of plan.snapshot) byLocation.set(s.locationId, [...(byLocation.get(s.locationId) ?? []), s]);
    for (const [locationId, lines] of byLocation) {
      result.locations++;
      const code = lines[0]!.locationCode;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stock-count:${locationId}`}))`);
      const [newer] = await tx
        .select({ id: stockCounts.id, asOf: stockCounts.asOf })
        .from(stockCounts)
        .where(
          and(
            eq(stockCounts.tenantId, ctx.tenantId),
            eq(stockCounts.locationId, locationId),
            eq(stockCounts.source, 'erp'),
            eq(stockCounts.connectionId, conn.id),
            eq(stockCounts.status, 'applied'),
            gte(stockCounts.asOf, job.snapshotAsOf),
          ),
        )
        .limit(1);
      const countId = randomUUID();
      const serial = await tx
        .select({ variantId: variantStockSettings.variantId })
        .from(variantStockSettings)
        .where(
          and(
            eq(variantStockSettings.tenantId, ctx.tenantId),
            eq(variantStockSettings.tracking, 'serial'),
            inArray(
              variantStockSettings.variantId,
              lines.map((l) => l.variantId),
            ),
          ),
        );
      const serialIds = new Set(serial.map((s) => s.variantId));
      const qtyLines = lines.filter((l) => !serialIds.has(l.variantId));
      if (!qtyLines.length) continue;
      const balances = await tx
        .select()
        .from(stockBalances)
        .where(
          and(
            eq(stockBalances.tenantId, ctx.tenantId),
            eq(stockBalances.locationId, locationId),
            eq(stockBalances.condition, 'sellable'),
            inArray(
              stockBalances.variantId,
              qtyLines.map((l) => l.variantId),
            ),
          ),
        )
        .orderBy(asc(stockBalances.variantId))
        .for('update');
      const balanceByVariant = new Map(balances.map((b) => [b.variantId, b]));
      // Sales the ERP already acknowledged are deducted there but still in our on-hand until shipped: add back.
      const acknowledged = await acknowledgedCommitments(
        tx,
        ctx.tenantId,
        conn.id,
        qtyLines.map((l) => l.variantId),
      );
      const computed = qtyLines.map((l) => {
        const b = balanceByVariant.get(l.variantId);
        const expected = qty(b?.onHand ?? '0');
        const addBack = acknowledged.get(`${l.variantId}:${locationId}`) ?? '0';
        if (!qtyIsZero(addBack)) result.addedBack = qtyAdd(result.addedBack, addBack);
        const counted = qtyAdd(l.counted, addBack);
        return {
          ...l,
          counted,
          expected,
          variance: qtySub(counted, expected),
          held: qtyAdd(b?.reserved ?? '0', b?.committed ?? '0'),
        };
      });
      const stale = newer !== undefined;
      await tx.insert(stockCounts).values({
        id: countId,
        tenantId: ctx.tenantId,
        locationId,
        source: 'erp',
        sourceVersion: job.cursorTo ?? job.id,
        connectionId: conn.id,
        asOf: job.snapshotAsOf,
        status: stale ? 'rejected_stale' : 'applied',
        reference: `ERP:${job.id}`,
        note: `ERP sync ${conn.name}`,
        createdBy: c.auth.userId,
      });
      await tx.insert(stockCountLines).values(
        computed.map((l) => ({
          tenantId: ctx.tenantId,
          countId,
          variantId: l.variantId,
          counted: l.counted,
          expected: l.expected,
          variance: l.variance,
        })),
      );
      if (stale) {
        result.stale++;
        if (
          await openIssue(tx, {
            tenantId: ctx.tenantId,
            domain: 'integration',
            kind: 'stale_snapshot',
            severity: 'warning',
            locationId,
            dedupeKey: `stale:${countId}`,
            correlationId: c.meta.correlationId,
            details: {
              connectionId: conn.id,
              jobId: job.id,
              countId,
              asOf: iso(job.snapshotAsOf),
              newerAsOf: iso(newer.asOf),
              source: 'erp',
            },
          })
        )
          result.issues++;
        continue;
      }
      const usable = [];
      for (const l of computed) {
        if (qtyCmp(l.counted, l.held) < 0) {
          if (
            await openIssue(tx, {
              tenantId: ctx.tenantId,
              domain: 'integration',
              kind: 'erp_stock_mismatch',
              severity: 'warning',
              variantId: l.variantId,
              locationId,
              dedupeKey: `erp-below-holds:${conn.id}:${l.variantId}:${locationId}`,
              correlationId: c.meta.correlationId,
              details: {
                connectionId: conn.id,
                jobId: job.id,
                sku: l.sku,
                externalId: l.externalId,
                locationCode: code,
                erp: l.counted,
                commerce: l.expected,
                heldOrCommitted: l.held,
                message:
                  'The source system has less stock than is held or committed here (likely sold in store). Release a hold or resolve the order.',
              },
            })
          )
            result.issues++;
          continue;
        }
        usable.push(l);
      }
      const moves = await postMovements(tx, {
        tenantId: ctx.tenantId,
        type: 'stocktake',
        operationId: countId,
        reference: `ERP:${job.id}:${code}`,
        reasonCode: 'erp_snapshot',
        note: `ERP sync ${conn.name}`,
        actorUserId: c.auth.userId,
        correlationId: c.meta.correlationId,
        lines: usable
          .filter((l) => !qtyIsZero(l.variance))
          .map((l) => ({
            variantId: l.variantId,
            locationId,
            condition: 'sellable' as const,
            onHand: l.variance,
            label: l.sku,
          })),
      });
      result.movements += moves.length;
      for (let i = 0; i < usable.length; i += 1000) {
        const values = usable
          .slice(i, i + 1000)
          .map(
            (l) =>
              sql`(${l.externalId}::text, ${qtySub(l.counted, acknowledged.get(`${l.variantId}:${locationId}`) ?? '0')}::text)`,
          );
        await tx.execute(sql`
          update external_records e
             set last_stock = coalesce(e.last_stock, '{}'::jsonb) || jsonb_build_object(${code}::text, v.counted)
            from (values ${sql.join(values, sql`, `)}) as v(external_id, counted)
           where e.connection_id = ${conn.id} and e.record_type = 'design' and e.external_id = v.external_id`);
      }
      await enqueueEvent(tx, {
        tenantId: ctx.tenantId,
        eventType: 'InventorySnapshotReceived',
        aggregateType: 'stock_count',
        aggregateId: countId,
        correlationId: c.meta.correlationId,
        payload: {
          countId,
          locationId,
          source: 'erp',
          connectionId: conn.id,
          asOf: iso(job.snapshotAsOf),
          status: 'applied',
          lines: usable.length,
        },
      });
    }
    return result;
  }

  // ---------------------------------------------------------------- reconciliation

  async reconcile(auth: AuthState, ctx: TenantState, connectionId: string, meta: RequestMeta) {
    requireIntegrations(ctx);
    requireUnscoped(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const conn = await loadConnection(tx, ctx, connectionId);
      const recs = await tx
        .select({ r: externalRecords, sku: variants.sku })
        .from(externalRecords)
        .innerJoin(variants, eq(variants.id, externalRecords.internalId))
        .where(
          and(
            eq(externalRecords.connectionId, conn.id),
            eq(externalRecords.recordType, 'design'),
            sql`${externalRecords.deletedAt} is null`,
            sql`${externalRecords.lastStock} is not null`,
          ),
        );
      const locs = await tx.select().from(locations).where(eq(locations.tenantId, ctx.tenantId));
      const acknowledged = await acknowledgedCommitments(
        tx,
        ctx.tenantId,
        conn.id,
        recs.map((x) => x.r.internalId),
      );
      let compared = 0;
      let mismatches = 0;
      let opened = 0;
      for (const { r, sku } of recs) {
        for (const [code, erp] of Object.entries(r.lastStock as Record<string, string>)) {
          const loc = locs.find((l) => l.code.toLowerCase() === code.toLowerCase());
          if (!loc) continue;
          compared++;
          const [b] = await tx
            .select()
            .from(stockBalances)
            .where(
              and(
                eq(stockBalances.variantId, r.internalId),
                eq(stockBalances.locationId, loc.id),
                eq(stockBalances.condition, 'sellable'),
              ),
            );
          const commerce = qty(b?.onHand ?? '0');
          // ERP figure + our committed units the ERP already acknowledged (deducted there, not yet shipped here).
          const erpEffective = qtyAdd(erp, acknowledged.get(`${r.internalId}:${loc.id}`) ?? '0');
          if (qtyCmp(commerce, erpEffective) === 0) continue;
          mismatches++;
          if (
            await openIssue(tx, {
              tenantId: ctx.tenantId,
              domain: 'integration',
              kind: 'erp_stock_mismatch',
              severity: 'warning',
              variantId: r.internalId,
              locationId: loc.id,
              dedupeKey: `erp-stock:${conn.id}:${r.internalId}:${loc.id}`,
              correlationId: meta.correlationId,
              details: {
                connectionId: conn.id,
                sku,
                externalId: r.externalId,
                locationCode: loc.code,
                erp: qty(erp),
                acknowledgedOrders: qtySub(erpEffective, erp),
                commerce,
              },
            })
          )
            opened++;
        }
      }
      await this.audit(tx, auth, ctx, meta, 'integration.reconciled', 'connection', conn.id, {
        newValues: { compared, mismatches, opened },
      });
      return { compared, mismatches, issuesOpened: opened };
    });
  }

  async discrepancies(
    ctx: TenantState,
    connectionId: string,
    status: 'open' | 'resolved',
  ): Promise<{ items: ReconciliationIssue[] }> {
    requireIntegrations(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      await loadConnection(tx, ctx, connectionId);
      const rows = await issueQuery(tx)
        .where(
          and(
            eq(reconciliationIssues.tenantId, ctx.tenantId),
            eq(reconciliationIssues.domain, 'integration'),
            eq(reconciliationIssues.status, status),
            sql`${reconciliationIssues.details}->>'connectionId' = ${connectionId}`,
          ),
        )
        .orderBy(desc(reconciliationIssues.createdAt))
        .limit(200);
      return { items: rows.map(toIssue) };
    });
  }

  async resolveDiscrepancy(
    auth: AuthState,
    ctx: TenantState,
    issueId: string,
    input: ResolveDiscrepancyRequest,
    meta: RequestMeta,
  ): Promise<ReconciliationIssue> {
    requireIntegrations(ctx);
    requireUnscoped(ctx);
    return this.db.tenant(ctx.tenantId, async (tx) => {
      const [issue] = await tx
        .select()
        .from(reconciliationIssues)
        .where(and(eq(reconciliationIssues.tenantId, ctx.tenantId), eq(reconciliationIssues.id, issueId)))
        .for('update');
      if (!issue || issue.domain !== 'integration') throw Errors.notFound('Discrepancy');
      if (issue.status !== 'open') throw new AppError(409, 'INVALID_STATE_TRANSITION', 'Already resolved');
      const details = issue.details as Record<string, string>;
      let adjustment: string | null = null;
      if (input.decision === 'accept_erp') {
        if (issue.kind !== 'erp_stock_mismatch' || !issue.variantId || !issue.locationId || !details.erp) {
          throw Errors.validation([
            { path: 'decision', message: 'Only stock mismatches can take the ERP value; use "keep ours"' },
          ]);
        }
        const [b] = await tx
          .select()
          .from(stockBalances)
          .where(
            and(
              eq(stockBalances.variantId, issue.variantId),
              eq(stockBalances.locationId, issue.locationId),
              eq(stockBalances.condition, 'sellable'),
            ),
          );
        const delta = qtySub(details.erp, b?.onHand ?? '0');
        if (!qtyIsZero(delta)) {
          await postMovements(tx, {
            tenantId: ctx.tenantId,
            type: 'adjustment',
            reasonCode: 'erp_reconciliation',
            note: input.note,
            actorUserId: auth.userId,
            correlationId: meta.correlationId,
            lines: [
              {
                variantId: issue.variantId,
                locationId: issue.locationId,
                condition: 'sellable',
                onHand: delta,
                label: details.sku,
              },
            ],
          });
          adjustment = delta;
        }
      }
      await tx
        .update(reconciliationIssues)
        .set({
          status: 'resolved',
          resolvedBy: auth.userId,
          resolutionNote: `[${input.decision}] ${input.note}`,
          resolvedAt: new Date(),
        })
        .where(eq(reconciliationIssues.id, issueId));
      await enqueueEvent(tx, {
        tenantId: ctx.tenantId,
        eventType: 'ReconciliationIssueResolved',
        aggregateType: 'reconciliation_issue',
        aggregateId: issueId,
        correlationId: meta.correlationId,
        payload: { issueId, domain: 'integration', kind: issue.kind, decision: input.decision, adjustment },
      });
      await this.audit(
        tx,
        auth,
        ctx,
        meta,
        'integration.discrepancy_resolved',
        'reconciliation_issue',
        issueId,
        {
          oldValues: { status: 'open' },
          newValues: { status: 'resolved', decision: input.decision, adjustment },
          reason: input.note,
        },
      );
      const [row] = await issueQuery(tx).where(eq(reconciliationIssues.id, issueId));
      return toIssue(row!);
    });
  }
}

export type { ExternalRow };
