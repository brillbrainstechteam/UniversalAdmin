import { PageQuery, Reason, Timestamp, Uuid, Version, pageOf } from '../common';
import { z } from '../z';

// ---------------------------------------------------------------- canonical record + mapping

/** Canonical fields a source column can be mapped to. */
export const MAPPING_TARGETS = {
  externalId: { label: 'External ID (stable, unique per record)', required: true },
  recordType: { label: 'Record type: design (stock by qty) or piece (tag-wise)', required: false },
  sku: { label: 'SKU (design) / design code that a piece belongs to', required: true },
  title: { label: 'Product title', required: false },
  productType: { label: 'Product type: standard or jewellery', required: false },
  purity: { label: 'Purity code (e.g. 22K, 18K, 925)', required: false },
  grossWeight: { label: 'Gross weight', required: false },
  netWeight: { label: 'Net weight', required: false },
  stoneWeight: { label: 'Stone weight', required: false },
  huid: { label: 'HUID', required: false },
  tag: { label: 'Tag / serial number (pieces)', required: false },
  location: { label: 'Location / branch / godown code', required: false },
  quantity: { label: 'Quantity on hand (designs)', required: false },
  unit: { label: 'Stock unit: pcs or g', required: false },
  version: { label: 'Source version / modified counter', required: false },
  updatedAt: { label: 'Source modified time', required: false },
  deleted: { label: 'Deleted / sold flag (yes/no)', required: false },
} as const;
export type MappingTarget = keyof typeof MAPPING_TARGETS;
export const MAPPING_TARGET_KEYS = Object.keys(MAPPING_TARGETS) as MappingTarget[];

export const MappingRule = z
  .object({
    target: z.enum(MAPPING_TARGET_KEYS as [MappingTarget, ...MappingTarget[]]),
    /** Source column / field name; omit to use `constant`. */
    source: z.string().trim().min(1).max(120).optional(),
    constant: z.string().trim().max(200).optional(),
    transform: z.enum(['none', 'trim', 'upper', 'lower']).default('trim'),
    /** Unit of the source value for weights (converted exactly to grams). */
    weightUnit: z.enum(['g', 'mg', 'kg', 'ct']).optional(),
  })
  .refine((r) => (r.source === undefined) !== (r.constant === undefined), {
    message: 'Give either a source column or a constant',
  })
  .openapi('MappingRule');
export type MappingRule = z.infer<typeof MappingRule>;

export const CanonicalRecord = z
  .object({
    externalId: z.string(),
    recordType: z.enum(['design', 'piece']),
    sku: z.string(),
    title: z.string().nullable(),
    productType: z.enum(['standard', 'jewellery']),
    purity: z.string().nullable(),
    grossG: z.string().nullable(),
    netG: z.string().nullable(),
    stoneG: z.string().nullable(),
    huid: z.string().nullable(),
    tag: z.string().nullable(),
    location: z.string().nullable(),
    quantity: z.string().nullable(),
    unit: z.enum(['pcs', 'g']),
    version: z.string().nullable(),
    updatedAt: z.string().nullable(),
    deleted: z.boolean(),
  })
  .openapi('CanonicalRecord');
export type CanonicalRecord = z.infer<typeof CanonicalRecord>;

// ---------------------------------------------------------------- connectors + discovery

const Capabilities = z.object({
  importCatalog: z.boolean(),
  importStock: z.boolean(),
  importPieces: z.boolean(),
  importMedia: z.boolean(),
  importRates: z.boolean(),
  pushOrders: z.boolean(),
  webhooks: z.boolean(),
});

export const DISCOVERY_STATUSES = ['not_started', 'requested', 'docs_received', 'sandbox_ready', 'pilot_passed'] as const;
export const DiscoveryStatus = z.enum(DISCOVERY_STATUSES);

export const DiscoveryAnswers = z
  .object({
    edition: z.string().trim().max(200).optional(),
    hosting: z.string().trim().max(200).optional(),
    integrationMethod: z.string().trim().max(500).optional(),
    authentication: z.string().trim().max(500).optional(),
    exportFormat: z.string().trim().max(500).optional(),
    identifierStability: z.string().trim().max(500).optional(),
    changeFeed: z.string().trim().max(500).optional(),
    granularity: z.string().trim().max(500).optional(),
    media: z.string().trim().max(500).optional(),
    writeback: z.string().trim().max(500).optional(),
    commercialTerms: z.string().trim().max(500).optional(),
    contact: z.string().trim().max(300).optional(),
  })
  .openapi('DiscoveryAnswers');

export const ConnectorView = z
  .object({
    key: z.string(),
    label: z.string(),
    vendor: z.string(),
    tier: z.enum(['file', 'simulator', 'vendor_api', 'desktop_agent']),
    status: z.enum(['available', 'blocked']),
    freshness: z.string(),
    capabilities: Capabilities,
    blockedOn: z.array(z.string()),
    references: z.array(z.object({ label: z.string(), url: z.string() })),
    fallback: z.string().nullable(),
    discovery: z
      .object({
        status: DiscoveryStatus,
        answers: DiscoveryAnswers,
        notes: z.string().nullable(),
        version: Version,
        updatedAt: Timestamp,
      })
      .nullable(),
    connections: z.number().int(),
  })
  .openapi('ConnectorView');
export type ConnectorView = z.infer<typeof ConnectorView>;
export const ConnectorCatalog = z
  .object({
    items: z.array(ConnectorView),
    blockedDependencies: z.array(
      z.object({ area: z.string(), item: z.string(), waitingFor: z.string(), phase: z.string() }),
    ),
  })
  .openapi('ConnectorCatalog');
export type ConnectorCatalog = z.infer<typeof ConnectorCatalog>;

export const PutDiscoveryRequest = z
  .object({
    version: Version,
    status: DiscoveryStatus,
    answers: DiscoveryAnswers.default({}),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .openapi('PutDiscoveryRequest');
export type PutDiscoveryRequest = z.infer<typeof PutDiscoveryRequest>;
export const ConnectorKeyParam = z.object({ key: z.string().regex(/^[a-z_]{2,40}$/) });

// ---------------------------------------------------------------- connections

export const OWNED_FIELDS = ['title', 'sku', 'weights', 'stock', 'pieces'] as const;
export const FieldOwner = z.enum(['erp', 'commerce']);
export const Ownership = z
  .object({
    title: FieldOwner,
    sku: FieldOwner,
    weights: FieldOwner,
    stock: FieldOwner,
    pieces: FieldOwner,
  })
  .openapi('FieldOwnership');
export type Ownership = z.infer<typeof Ownership>;
export const DEFAULT_OWNERSHIP: Ownership = {
  title: 'commerce',
  sku: 'erp',
  weights: 'erp',
  stock: 'erp',
  pieces: 'erp',
};

export const ConnectionSettings = z
  .object({
    /** Link an existing commerce product whose SKU matches (otherwise a collision is an error). */
    linkExistingBySku: z.boolean().default(false),
    /** What a deleted/sold flag does: always flag for review (never silent deletion). */
    deletionPolicy: z.literal('flag').default('flag'),
    defaultLocationCode: z.string().trim().max(40).nullable().default(null),
    defaultProductType: z.enum(['standard', 'jewellery']).default('standard'),
    /** Send confirmed orders to this connection (only connectors that can receive orders). */
    exportOrders: z.boolean().default(false),
  })
  .openapi('ConnectionSettings');
export type ConnectionSettings = z.infer<typeof ConnectionSettings>;

export const Connection = z
  .object({
    id: Uuid,
    connectorKey: z.string(),
    connectorLabel: z.string(),
    name: z.string(),
    status: z.enum(['active', 'paused', 'disconnected']),
    /** Reference to a secret in the secret store; the secret itself is never returned. */
    credentialRef: z.string().nullable(),
    settings: ConnectionSettings,
    ownership: Ownership,
    activeMappingVersion: z.number().int().nullable(),
    lastSyncAt: Timestamp.nullable(),
    lastSuccessAt: Timestamp.nullable(),
    freshness: z.string(),
    openIssues: z.number().int(),
    pendingOutbound: z.number().int(),
    failedOutbound: z.number().int(),
    version: Version,
    createdAt: Timestamp,
  })
  .openapi('Connection');
export type Connection = z.infer<typeof Connection>;
export const ConnectionList = z.object({ items: z.array(Connection) }).openapi('ConnectionList');

export const CreateConnectionRequest = z
  .object({
    connectorKey: z.string().regex(/^[a-z_]{2,40}$/),
    name: z.string().trim().min(2).max(80),
    credentialRef: z
      .string()
      .trim()
      .regex(/^(vault|env|secretsmanager):[A-Za-z0-9_./:-]{1,200}$/, 'Use a secret reference like vault:erp/merchant-a')
      .nullable()
      .optional(),
    settings: ConnectionSettings.partial().optional(),
    ownership: Ownership.partial().optional(),
  })
  .openapi('CreateConnectionRequest');
export type CreateConnectionRequest = z.infer<typeof CreateConnectionRequest>;

export const UpdateConnectionRequest = z
  .object({
    version: Version,
    name: z.string().trim().min(2).max(80).optional(),
    status: z.enum(['active', 'paused', 'disconnected']).optional(),
    credentialRef: CreateConnectionRequest.shape.credentialRef,
    settings: ConnectionSettings.partial().optional(),
    ownership: Ownership.partial().optional(),
    reason: Reason.optional(),
  })
  .openapi('UpdateConnectionRequest');
export type UpdateConnectionRequest = z.infer<typeof UpdateConnectionRequest>;

// ---------------------------------------------------------------- mappings

export const FieldMapping = z
  .object({
    id: Uuid,
    version: z.number().int(),
    rules: z.array(MappingRule),
    notes: z.string().nullable(),
    active: z.boolean(),
    createdBy: z.string().nullable(),
    createdAt: Timestamp,
  })
  .openapi('FieldMapping');
export type FieldMapping = z.infer<typeof FieldMapping>;
export const FieldMappingList = z.object({ items: z.array(FieldMapping) }).openapi('FieldMappingList');
export const CreateMappingRequest = z
  .object({
    rules: z.array(MappingRule).min(1).max(40),
    notes: z.string().trim().max(500).optional(),
  })
  .openapi('CreateMappingRequest');
export type CreateMappingRequest = z.infer<typeof CreateMappingRequest>;

export const MappingPreviewRequest = z
  .object({
    rules: z.array(MappingRule).min(1).max(40),
    /** Raw sample rows (column → value). */
    rows: z.array(z.record(z.string().max(2000))).min(1).max(20),
  })
  .openapi('MappingPreviewRequest');
export const MappingPreviewResponse = z
  .object({
    rows: z.array(
      z.object({
        record: CanonicalRecord.nullable(),
        errors: z.array(z.object({ field: z.string(), message: z.string() })),
      }),
    ),
  })
  .openapi('MappingPreviewResponse');
export type MappingPreviewResponse = z.infer<typeof MappingPreviewResponse>;

// ---------------------------------------------------------------- jobs

export const ROW_ACTIONS = ['create', 'update', 'unchanged', 'stale', 'delete', 'error'] as const;
export const RowAction = z.enum(ROW_ACTIONS);
export const JobCounts = z.object({
  total: z.number().int(),
  create: z.number().int(),
  update: z.number().int(),
  unchanged: z.number().int(),
  stale: z.number().int(),
  delete: z.number().int(),
  error: z.number().int(),
  applied: z.number().int(),
});
export type JobCounts = z.infer<typeof JobCounts>;

export const SyncJob = z
  .object({
    id: Uuid,
    connectionId: Uuid,
    connectionName: z.string(),
    source: z.enum(['file', 'simulator']),
    status: z.enum(['previewed', 'committed', 'partially_committed', 'discarded', 'failed']),
    mappingVersion: z.number().int(),
    fileName: z.string().nullable(),
    cursorFrom: z.string().nullable(),
    cursorTo: z.string().nullable(),
    snapshotAsOf: Timestamp,
    counts: JobCounts,
    stockResult: z
      .object({
        locations: z.number().int(),
        movements: z.number().int(),
        stale: z.number().int(),
        issues: z.number().int(),
        /** Units committed to orders the ERP already acknowledged, added back to the ERP figure (no double subtract). */
        addedBack: z.string().optional(),
      })
      .nullable(),
    error: z.string().nullable(),
    createdBy: z.string().nullable(),
    createdAt: Timestamp,
    committedAt: Timestamp.nullable(),
  })
  .openapi('SyncJob');
export type SyncJob = z.infer<typeof SyncJob>;
export const SyncJobPage = pageOf(SyncJob).openapi('SyncJobPage');
export const SyncJobListQuery = PageQuery.extend({ connectionId: Uuid.optional() });
export type SyncJobListQuery = z.infer<typeof SyncJobListQuery>;

export const SyncJobRow = z
  .object({
    rowNo: z.number().int(),
    externalId: z.string().nullable(),
    action: RowAction,
    applied: z.boolean(),
    errors: z.array(z.object({ field: z.string(), message: z.string() })),
    record: CanonicalRecord.nullable(),
    raw: z.record(z.unknown()),
  })
  .openapi('SyncJobRow');
export type SyncJobRow = z.infer<typeof SyncJobRow>;
export const SyncJobRowPage = pageOf(SyncJobRow).openapi('SyncJobRowPage');
export const SyncJobRowQuery = PageQuery.extend({ action: RowAction.optional() });
export type SyncJobRowQuery = z.infer<typeof SyncJobRowQuery>;

export const CommitJobRequest = z
  .object({ mode: z.enum(['atomic', 'partial']).default('atomic') })
  .openapi('CommitJobRequest');
export type CommitJobRequest = z.infer<typeof CommitJobRequest>;

export const FilePreviewRequest = z
  .object({
    /** CSV text, or base64 XLSX content. */
    fileName: z.string().trim().min(1).max(200),
    contentBase64: z.string().min(1).max(3_300_000),
  })
  .openapi('FilePreviewRequest');
export type FilePreviewRequest = z.infer<typeof FilePreviewRequest>;

// ---------------------------------------------------------------- records, simulator, outbound, discrepancies

export const ExternalRecord = z
  .object({
    recordType: z.enum(['design', 'piece']),
    externalId: z.string(),
    internalType: z.enum(['variant', 'serial_item']),
    internalId: Uuid,
    label: z.string(),
    externalVersion: z.string().nullable(),
    sourceTimestamp: Timestamp.nullable(),
    deletedAt: Timestamp.nullable(),
    updatedAt: Timestamp,
  })
  .openapi('ExternalRecord');
export const ExternalRecordPage = pageOf(ExternalRecord).openapi('ExternalRecordPage');
export const ExternalRecordQuery = PageQuery.extend({ q: z.string().trim().max(100).optional() });
export type ExternalRecordQuery = z.infer<typeof ExternalRecordQuery>;

export const SimulatorState = z
  .object({
    tick: z.number().int(),
    failNext: z.number().int(),
    timeoutNext: z.number().int(),
    receivedOrders: z.number().int(),
    description: z.string(),
  })
  .openapi('SimulatorState');
export type SimulatorState = z.infer<typeof SimulatorState>;
export const SimulatorFailuresRequest = z
  .object({ failNext: z.number().int().min(0).max(20), timeoutNext: z.number().int().min(0).max(20) })
  .openapi('SimulatorFailuresRequest');
export type SimulatorFailuresRequest = z.infer<typeof SimulatorFailuresRequest>;

export const OutboundCommand = z
  .object({
    id: Uuid,
    connectionId: Uuid,
    kind: z.literal('push_order'),
    reference: z.string(),
    status: z.enum(['pending', 'acknowledged', 'failed']),
    attempts: z.number().int(),
    nextAttemptAt: Timestamp.nullable(),
    lastError: z.string().nullable(),
    externalRef: z.string().nullable(),
    payload: z.record(z.unknown()),
    createdAt: Timestamp,
    acknowledgedAt: Timestamp.nullable(),
  })
  .openapi('OutboundCommand');
export type OutboundCommand = z.infer<typeof OutboundCommand>;
export const OutboundCommandPage = pageOf(OutboundCommand).openapi('OutboundCommandPage');
export const OutboundListQuery = PageQuery.extend({
  connectionId: Uuid.optional(),
  status: z.enum(['pending', 'acknowledged', 'failed']).optional(),
});
export type OutboundListQuery = z.infer<typeof OutboundListQuery>;
export const TestOrderRequest = z
  .object({
    reference: z.string().trim().regex(/^[A-Za-z0-9_.:-]{3,80}$/),
    lines: z
      .array(z.object({ sku: z.string().trim().min(1).max(80), quantity: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/) }))
      .min(1)
      .max(50),
  })
  .openapi('TestOrderRequest');
export type TestOrderRequest = z.infer<typeof TestOrderRequest>;

export const ResolveDiscrepancyRequest = z
  .object({ decision: z.enum(['accept_erp', 'keep_commerce']), note: Reason })
  .openapi('ResolveDiscrepancyRequest');
export type ResolveDiscrepancyRequest = z.infer<typeof ResolveDiscrepancyRequest>;
export const ReconcileConnectionResponse = z
  .object({ compared: z.number().int(), mismatches: z.number().int(), issuesOpened: z.number().int() })
  .openapi('ReconcileConnectionResponse');
