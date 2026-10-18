import { PageQuery, Reason, Timestamp, Uuid, Version, pageOf } from '../common';
import { STOCK_UNITS } from '../stock-math';
import { z } from '../z';

export const StockCondition = z.enum(['sellable', 'damaged', 'quarantine', 'in_transit']);
export type StockCondition = z.infer<typeof StockCondition>;
/** Conditions a person can put stock into directly (in transit is only reached through a transfer). */
export const HoldingCondition = z.enum(['sellable', 'damaged', 'quarantine']);
const StockUnit = z.enum(STOCK_UNITS);
export const StockTracking = z.enum(['quantity', 'serial']);
export const MovementType = z.enum([
  'receipt',
  'adjustment',
  'condition_change',
  'transfer_dispatch',
  'transfer_receive',
  'transfer_cancel',
  'stocktake',
  'reservation_hold',
  'reservation_release',
  'reservation_expire',
  'reservation_commit',
  'commitment_release',
  'write_off',
]);
export type MovementType = z.infer<typeof MovementType>;
export const SerialStockState = z.enum(['not_received', 'in_stock', 'reserved', 'committed', 'in_transit', 'written_off']);

/** Exact quantity as a decimal string (pieces must be whole; grams up to 6 dp). */
export const Quantity = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,6})?$/, 'Use a positive number with up to 6 decimals')
  .refine((v) => /[1-9]/.test(v), 'Quantity must be greater than 0')
  .openapi({ description: 'Positive decimal quantity (string)', example: '2' });
export const SignedQuantity = z
  .string()
  .regex(/^-?\d{1,14}(\.\d{1,6})?$/, 'Use a number with up to 6 decimals, negative to remove stock')
  .refine((v) => /[1-9]/.test(v), 'Change cannot be zero')
  .openapi({ description: 'Signed decimal quantity (string)', example: '-1' });
export const NonNegativeQuantity = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,6})?$/, 'Use a number ≥ 0 with up to 6 decimals')
  .openapi({ description: 'Non-negative decimal quantity (string)', example: '0' });
const Qty = z.string().openapi({ description: 'Decimal quantity (string, 6 dp)' });
const Ref = z.string().trim().min(1).max(80);
const Note = z.string().trim().max(500);

export const LocationRef = z.object({ id: Uuid, code: z.string(), name: z.string() }).openapi('LocationRef');
export const ActorRef = z.object({ id: Uuid, name: z.string() }).nullable();

// ---------------------------------------------------------------- settings

export const StockSettings = z
  .object({
    defaultBuffer: Qty,
    reservationTtlMinutes: z.number().int(),
    lowStockThreshold: Qty,
    backorderPolicy: z.literal('disabled'),
    version: Version,
    updatedAt: Timestamp,
  })
  .openapi('StockSettings');
export type StockSettings = z.infer<typeof StockSettings>;

export const UpdateStockSettingsRequest = z
  .object({
    version: Version,
    defaultBuffer: NonNegativeQuantity.optional(),
    reservationTtlMinutes: z.number().int().min(1).max(10080).optional(),
    lowStockThreshold: NonNegativeQuantity.optional(),
  })
  .openapi('UpdateStockSettingsRequest');
export type UpdateStockSettingsRequest = z.infer<typeof UpdateStockSettingsRequest>;

export const VariantStockSettings = z
  .object({
    tracking: StockTracking,
    unit: StockUnit,
    /** null = tenant default */
    buffer: Qty.nullable(),
    lowStockThreshold: Qty.nullable(),
    effectiveBuffer: Qty,
    effectiveLowStockThreshold: Qty,
    version: Version,
  })
  .openapi('VariantStockSettings');
export type VariantStockSettings = z.infer<typeof VariantStockSettings>;

export const UpdateVariantStockSettingsRequest = z
  .object({
    version: Version,
    tracking: StockTracking.optional(),
    unit: StockUnit.optional(),
    buffer: NonNegativeQuantity.nullable().optional(),
    lowStockThreshold: NonNegativeQuantity.nullable().optional(),
  })
  .openapi('UpdateVariantStockSettingsRequest');
export type UpdateVariantStockSettingsRequest = z.infer<typeof UpdateVariantStockSettingsRequest>;

export const ChannelStockLocations = z
  .object({
    channelId: Uuid,
    code: z.string(),
    name: z.string(),
    /** Empty = every active location feeds this channel. */
    locationIds: z.array(Uuid),
  })
  .openapi('ChannelStockLocations');
export type ChannelStockLocations = z.infer<typeof ChannelStockLocations>;
export const ChannelStockLocationsList = z.object({ items: z.array(ChannelStockLocations) }).openapi('ChannelStockLocationsList');
export const PutChannelLocationsRequest = z
  .object({ locationIds: z.array(Uuid).max(200) })
  .openapi('PutChannelLocationsRequest');
export type PutChannelLocationsRequest = z.infer<typeof PutChannelLocationsRequest>;

// ---------------------------------------------------------------- levels

export const StockLevel = z
  .object({
    variantId: Uuid,
    productId: Uuid,
    productTitle: z.string(),
    variantTitle: z.string(),
    sku: z.string(),
    tracking: StockTracking,
    unit: StockUnit,
    onHand: Qty,
    reserved: Qty,
    committed: Qty,
    /** Σ sellable (on hand − reserved − committed) in the selected locations. */
    available: Qty,
    unsellable: Qty,
    inTransit: Qty,
    buffer: Qty,
    /** max(0, available − buffer); for a channel only its stock locations count. */
    atp: Qty,
    lowStock: z.boolean(),
  })
  .openapi('StockLevel');
export type StockLevel = z.infer<typeof StockLevel>;
export const StockLevelPage = pageOf(StockLevel).openapi('StockLevelPage');

export const StockLevelQuery = PageQuery.extend({
  q: z.string().trim().max(100).optional(),
  locationId: Uuid.optional(),
  channelId: Uuid.optional(),
  stock: z.enum(['all', 'low', 'out', 'in']).default('all'),
});
export type StockLevelQuery = z.infer<typeof StockLevelQuery>;

export const InventorySummary = z
  .object({
    trackedVariants: z.number().int(),
    lowStock: z.number().int(),
    outOfStock: z.number().int(),
    activeHolds: z.number().int(),
    committedReservations: z.number().int(),
    transfersInTransit: z.number().int(),
    openIssues: z.number().int(),
  })
  .openapi('InventorySummary');
export type InventorySummary = z.infer<typeof InventorySummary>;

export const StockBalance = z
  .object({
    location: LocationRef,
    condition: StockCondition,
    onHand: Qty,
    reserved: Qty,
    committed: Qty,
    available: Qty,
    updatedAt: Timestamp,
  })
  .openapi('StockBalance');

export const VariantStock = z
  .object({
    variantId: Uuid,
    productId: Uuid,
    productTitle: z.string(),
    variantTitle: z.string(),
    sku: z.string(),
    productType: z.string(),
    settings: VariantStockSettings,
    balances: z.array(StockBalance),
    atp: z.object({
      total: Qty,
      byLocation: z.array(z.object({ location: LocationRef, available: Qty })),
      byChannel: z.array(z.object({ channelId: Uuid, name: z.string(), atp: Qty })),
    }),
    pieces: z.array(
      z.object({
        id: Uuid,
        serialTag: z.string(),
        huid: z.string().nullable(),
        status: z.string(),
        stockState: SerialStockState,
        location: LocationRef.nullable(),
        grossG: z.string(),
      }),
    ),
  })
  .openapi('VariantStock');
export type VariantStock = z.infer<typeof VariantStock>;

// ---------------------------------------------------------------- ledger

export const StockMovement = z
  .object({
    id: Uuid,
    variantId: Uuid,
    sku: z.string(),
    location: LocationRef,
    condition: StockCondition,
    serialItem: z.object({ id: Uuid, serialTag: z.string() }).nullable(),
    type: MovementType,
    onHandDelta: Qty,
    reservedDelta: Qty,
    committedDelta: Qty,
    reasonCode: z.string().nullable(),
    note: z.string().nullable(),
    reference: z.string().nullable(),
    operationId: Uuid,
    reservationId: Uuid.nullable(),
    actor: ActorRef,
    occurredAt: Timestamp,
  })
  .openapi('StockMovement');
export type StockMovement = z.infer<typeof StockMovement>;
export const StockMovementPage = pageOf(StockMovement).openapi('StockMovementPage');

export const MovementQuery = PageQuery.extend({
  variantId: Uuid.optional(),
  locationId: Uuid.optional(),
  type: MovementType.optional(),
  operationId: Uuid.optional(),
  reference: z.string().trim().max(80).optional(),
});
export type MovementQuery = z.infer<typeof MovementQuery>;

export const StockOperationResult = z
  .object({
    operationId: Uuid,
    type: MovementType,
    reference: z.string().nullable(),
    movements: z.array(StockMovement),
  })
  .openapi('StockOperationResult');
export type StockOperationResult = z.infer<typeof StockOperationResult>;

// ---------------------------------------------------------------- operations

export const ReceiptRequest = z
  .object({
    locationId: Uuid,
    condition: HoldingCondition.default('sellable'),
    /** Supplier GRN / delivery note. A reference can be posted only once (no double counting). */
    reference: Ref.optional(),
    note: Note.optional(),
    lines: z
      .array(
        z
          .object({
            variantId: Uuid,
            /** Quantity-tracked variants. */
            quantity: Quantity.optional(),
            /** Serial-tracked variants: the exact pieces received. */
            serialItemIds: z.array(Uuid).min(1).max(200).optional(),
          })
          .refine((l) => (l.quantity === undefined) !== (l.serialItemIds === undefined), {
            message: 'Give either quantity or serialItemIds',
          }),
      )
      .min(1)
      .max(200),
  })
  .openapi('ReceiptRequest');
export type ReceiptRequest = z.infer<typeof ReceiptRequest>;

export const ADJUSTMENT_REASONS = ['count_correction', 'damage', 'loss', 'theft', 'found', 'data_correction', 'sample', 'other'] as const;
export const AdjustmentReason = z.enum(ADJUSTMENT_REASONS);

export const AdjustmentRequest = z
  .object({
    locationId: Uuid,
    condition: HoldingCondition.default('sellable'),
    reasonCode: AdjustmentReason,
    note: Reason,
    reference: Ref.optional(),
    lines: z.array(z.object({ variantId: Uuid, delta: SignedQuantity })).min(1).max(200),
  })
  .openapi('AdjustmentRequest');
export type AdjustmentRequest = z.infer<typeof AdjustmentRequest>;

export const ConditionChangeRequest = z
  .object({
    locationId: Uuid,
    variantId: Uuid,
    from: HoldingCondition,
    to: HoldingCondition,
    quantity: Quantity,
    note: Reason,
  })
  .refine((v) => v.from !== v.to, { message: 'From and to conditions must differ', path: ['to'] })
  .openapi('ConditionChangeRequest');
export type ConditionChangeRequest = z.infer<typeof ConditionChangeRequest>;

export const WriteOffRequest = z.object({ reason: Reason }).openapi('WriteOffRequest');
export type WriteOffRequest = z.infer<typeof WriteOffRequest>;

// ---------------------------------------------------------------- reservations

export const ReservationStatus = z.enum(['held', 'committed', 'released', 'expired']);
export const ReservationReferenceType = z.enum(['manual', 'cart', 'checkout', 'order', 'quote']);

export const Reservation = z
  .object({
    id: Uuid,
    variantId: Uuid,
    sku: z.string(),
    productTitle: z.string(),
    location: LocationRef,
    serialItem: z.object({ id: Uuid, serialTag: z.string() }).nullable(),
    channelId: Uuid.nullable(),
    quantity: Qty,
    status: ReservationStatus,
    referenceType: ReservationReferenceType,
    referenceId: z.string().nullable(),
    expiresAt: Timestamp.nullable(),
    note: z.string().nullable(),
    createdBy: ActorRef,
    closedReason: z.string().nullable(),
    closedAt: Timestamp.nullable(),
    version: Version,
    createdAt: Timestamp,
  })
  .openapi('Reservation');
export type Reservation = z.infer<typeof Reservation>;
export const ReservationPage = pageOf(Reservation).openapi('ReservationPage');

export const ReservationListQuery = PageQuery.extend({
  status: ReservationStatus.optional(),
  variantId: Uuid.optional(),
  locationId: Uuid.optional(),
});
export type ReservationListQuery = z.infer<typeof ReservationListQuery>;

export const CreateReservationRequest = z
  .object({
    variantId: Uuid,
    quantity: Quantity,
    /** Optional; otherwise the eligible location with the most available stock is chosen. */
    locationId: Uuid.optional(),
    /** Required for serial-tracked variants: the exact piece to hold. */
    serialItemId: Uuid.optional(),
    /** Limits the hold to this channel's stock locations and checks its ATP. */
    channelId: Uuid.optional(),
    referenceType: ReservationReferenceType.default('manual'),
    referenceId: z.string().trim().max(120).optional(),
    ttlMinutes: z.number().int().min(1).max(10080).optional(),
    note: Note.optional(),
  })
  .openapi('CreateReservationRequest');
export type CreateReservationRequest = z.infer<typeof CreateReservationRequest>;

export const ReleaseReservationRequest = z
  .object({ reason: z.string().trim().max(500).optional() })
  .openapi('ReleaseReservationRequest');
export type ReleaseReservationRequest = z.infer<typeof ReleaseReservationRequest>;

// ---------------------------------------------------------------- transfers

export const Transfer = z
  .object({
    id: Uuid,
    number: z.string(),
    from: LocationRef,
    to: LocationRef,
    status: z.enum(['in_transit', 'received', 'cancelled']),
    note: z.string().nullable(),
    lines: z.array(
      z.object({
        variantId: Uuid,
        sku: z.string(),
        productTitle: z.string(),
        quantity: Qty,
        serialItem: z.object({ id: Uuid, serialTag: z.string() }).nullable(),
      }),
    ),
    createdBy: ActorRef,
    receivedBy: ActorRef,
    receivedAt: Timestamp.nullable(),
    version: Version,
    createdAt: Timestamp,
  })
  .openapi('Transfer');
export type Transfer = z.infer<typeof Transfer>;
export const TransferPage = pageOf(Transfer.omit({ lines: true }).extend({ lineCount: z.number().int() })).openapi('TransferPage');

export const TransferListQuery = PageQuery.extend({
  status: z.enum(['in_transit', 'received', 'cancelled']).optional(),
  locationId: Uuid.optional(),
});
export type TransferListQuery = z.infer<typeof TransferListQuery>;

export const CreateTransferRequest = z
  .object({
    fromLocationId: Uuid,
    toLocationId: Uuid,
    note: Note.optional(),
    lines: z
      .array(
        z
          .object({ variantId: Uuid, quantity: Quantity.optional(), serialItemId: Uuid.optional() })
          .refine((l) => (l.quantity === undefined) !== (l.serialItemId === undefined), {
            message: 'Give either quantity or serialItemId',
          }),
      )
      .min(1)
      .max(200),
  })
  .refine((v) => v.fromLocationId !== v.toLocationId, { message: 'Choose two different locations', path: ['toLocationId'] })
  .openapi('CreateTransferRequest');
export type CreateTransferRequest = z.infer<typeof CreateTransferRequest>;

export const TransferActionRequest = z.object({ version: Version, note: Note.optional() }).openapi('TransferActionRequest');
export type TransferActionRequest = z.infer<typeof TransferActionRequest>;

// ---------------------------------------------------------------- stocktakes

export const StockCountLine = z.object({
  variantId: Uuid,
  sku: z.string(),
  counted: Qty,
  expected: Qty,
  variance: Qty,
});

export const StockCount = z
  .object({
    id: Uuid.nullable(),
    location: LocationRef,
    source: z.enum(['stocktake', 'import', 'erp']),
    sourceVersion: z.string().nullable(),
    asOf: Timestamp,
    /** preview = dry run, nothing written. */
    status: z.enum(['applied', 'rejected_stale', 'preview']),
    reference: z.string().nullable(),
    note: z.string().nullable(),
    operationId: Uuid.nullable(),
    issueId: Uuid.nullable(),
    lines: z.array(StockCountLine),
    createdBy: ActorRef,
    createdAt: Timestamp.nullable(),
  })
  .openapi('StockCount');
export type StockCount = z.infer<typeof StockCount>;
export const StockCountPage = pageOf(StockCount.omit({ lines: true }).extend({ lineCount: z.number().int() })).openapi('StockCountPage');
export const StockCountListQuery = PageQuery.extend({ locationId: Uuid.optional() });
export type StockCountListQuery = z.infer<typeof StockCountListQuery>;

export const CreateStockCountRequest = z
  .object({
    locationId: Uuid,
    /** When the count was taken. A count older than the last applied one for the location is stale. */
    asOf: Timestamp,
    source: z.enum(['stocktake', 'import']).default('stocktake'),
    sourceVersion: z.string().trim().max(80).optional(),
    reference: Ref.optional(),
    note: Note.optional(),
    dryRun: z.boolean().default(false),
    lines: z.array(z.object({ variantId: Uuid, counted: NonNegativeQuantity })).min(1).max(500),
  })
  .openapi('CreateStockCountRequest');
export type CreateStockCountRequest = z.infer<typeof CreateStockCountRequest>;

// ---------------------------------------------------------------- reconciliation

export const IssueKind = z.enum(['ledger_balance_mismatch', 'stale_snapshot', 'stocktake_variance', 'serial_state_mismatch']);
export const ReconciliationIssue = z
  .object({
    id: Uuid,
    domain: z.literal('inventory'),
    kind: IssueKind,
    severity: z.enum(['info', 'warning', 'critical']),
    variant: z.object({ id: Uuid, sku: z.string() }).nullable(),
    location: LocationRef.nullable(),
    details: z.record(z.unknown()),
    status: z.enum(['open', 'resolved']),
    resolvedBy: ActorRef,
    resolutionNote: z.string().nullable(),
    resolvedAt: Timestamp.nullable(),
    createdAt: Timestamp,
  })
  .openapi('ReconciliationIssue');
export type ReconciliationIssue = z.infer<typeof ReconciliationIssue>;
export const ReconciliationIssuePage = pageOf(ReconciliationIssue).openapi('ReconciliationIssuePage');
export const IssueListQuery = PageQuery.extend({
  status: z.enum(['open', 'resolved']).default('open'),
  kind: IssueKind.optional(),
});
export type IssueListQuery = z.infer<typeof IssueListQuery>;
export const ResolveIssueRequest = z.object({ note: Reason }).openapi('ResolveIssueRequest');
export type ResolveIssueRequest = z.infer<typeof ResolveIssueRequest>;
export const ReconcileResponse = z
  .object({ checked: z.number().int(), mismatches: z.number().int(), issuesOpened: z.number().int() })
  .openapi('ReconcileResponse');
export type ReconcileResponse = z.infer<typeof ReconcileResponse>;
