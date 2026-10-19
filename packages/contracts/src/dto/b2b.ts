import { CurrencyCode, Email, PageQuery, Reason, Timestamp, Uuid, Version, pageOf } from '../common';
import { z } from '../z';
import { Address } from './admin';
import { Password } from './auth';
import { ActorRef } from './inventory';
import { OrderSummary } from './orders';
import { QuoteLineInput } from './pricing';

/**
 * Phase 08 B2B contracts: companies, locations, buyers, credit ledger, RFQs and the buyer portal API.
 * Buyer APIs live under /v1/storefront/b2b and are resolved from the B2B storefront domain + a buyer session.
 */
const MinorAmount = z.string().regex(/^\d{1,18}$/, 'Whole minor units').openapi({ description: 'Integer minor units (string)' });
const SignedMinor = z.string().regex(/^-?\d{1,18}$/).openapi({ description: 'Signed integer minor units (string)' });

/** Indian GSTIN shape: 2-digit state, 10-char PAN, entity digit, Z, check char. Format only — not verified. */
export const Gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'GSTIN must look like 27AAPFU0939F1ZV (15 characters)');

export const CompanyStatus = z.enum(['active', 'on_hold', 'inactive']);
export const BuyerRole = z.enum(['buyer', 'approver', 'admin']);
export type BuyerRole = z.infer<typeof BuyerRole>;

export const CompanyLocation = z
  .object({
    id: Uuid,
    name: z.string(),
    code: z.string(),
    address: Address,
    status: z.enum(['active', 'inactive']),
    version: Version,
  })
  .openapi('CompanyLocation');
export type CompanyLocation = z.infer<typeof CompanyLocation>;

export const CompanyBuyer = z
  .object({
    id: Uuid,
    user: z.object({ id: Uuid, email: z.string(), displayName: z.string() }).nullable(),
    email: z.string(),
    role: BuyerRole,
    /** null = all company locations */
    locationIds: z.array(Uuid).nullable(),
    orderLimitMinor: MinorAmount.nullable(),
    status: z.enum(['invited', 'active', 'disabled']),
    invitationExpiresAt: Timestamp.nullable(),
    version: Version,
  })
  .openapi('CompanyBuyer');
export type CompanyBuyer = z.infer<typeof CompanyBuyer>;

export const CreditSummary = z
  .object({
    currency: CurrencyCode,
    limitMinor: MinorAmount.nullable(),
    exposureMinor: SignedMinor,
    availableMinor: SignedMinor.nullable(),
    authority: z.enum(['commerce', 'erp']),
  })
  .openapi('CreditSummary');
export type CreditSummary = z.infer<typeof CreditSummary>;

export const Company = z
  .object({
    id: Uuid,
    name: z.string(),
    code: z.string(),
    gstin: z.string().nullable(),
    status: CompanyStatus,
    paymentTerms: z.enum(['prepaid', 'on_account']),
    creditLimitMinor: MinorAmount.nullable(),
    minOrderMinor: MinorAmount.nullable(),
    accountingAuthority: z.enum(['commerce', 'erp']),
    salesRep: ActorRef,
    priceBook: z.object({ id: Uuid, name: z.string() }).nullable(),
    catalogMode: z.enum(['all', 'collections']),
    collectionIds: z.array(Uuid),
    notes: z.string().nullable(),
    credit: CreditSummary,
    locations: z.array(CompanyLocation),
    buyers: z.array(CompanyBuyer),
    version: Version,
    createdAt: Timestamp,
  })
  .openapi('Company');
export type Company = z.infer<typeof Company>;

export const CompanySummary = Company.pick({ id: true, name: true, code: true, status: true, paymentTerms: true, salesRep: true, createdAt: true })
  .extend({ buyerCount: z.number().int(), exposureMinor: SignedMinor, currency: CurrencyCode })
  .openapi('CompanySummary');
export type CompanySummary = z.infer<typeof CompanySummary>;
export const CompanyPage = pageOf(CompanySummary).openapi('CompanyPage');
export const CompanyListQuery = PageQuery.extend({ q: z.string().trim().max(100).optional(), status: CompanyStatus.optional() });
export type CompanyListQuery = z.infer<typeof CompanyListQuery>;

const CompanyFields = {
  name: z.string().trim().min(1).max(120),
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9][A-Z0-9-]{1,29}$/, 'Upper-case letters, digits and hyphens (2–30)'),
  gstin: Gstin.nullable(),
  paymentTerms: z.enum(['prepaid', 'on_account']),
  creditLimitMinor: MinorAmount.nullable(),
  minOrderMinor: MinorAmount.nullable(),
  accountingAuthority: z.enum(['commerce', 'erp']),
  salesRepUserId: Uuid.nullable(),
  priceBookId: Uuid.nullable(),
  catalogMode: z.enum(['all', 'collections']),
  collectionIds: z.array(Uuid).max(50),
  notes: z.string().trim().max(1000).nullable(),
};
export const CreateCompanyRequest = z
  .object(CompanyFields)
  .partial({ gstin: true, creditLimitMinor: true, minOrderMinor: true, accountingAuthority: true, salesRepUserId: true, priceBookId: true, catalogMode: true, collectionIds: true, notes: true, paymentTerms: true })
  .openapi('CreateCompanyRequest');
export type CreateCompanyRequest = z.infer<typeof CreateCompanyRequest>;
export const UpdateCompanyRequest = z
  .object({ version: Version, status: CompanyStatus, ...CompanyFields })
  .partial()
  .required({ version: true })
  .openapi('UpdateCompanyRequest');
export type UpdateCompanyRequest = z.infer<typeof UpdateCompanyRequest>;

export const CreateCompanyLocationRequest = z
  .object({ name: z.string().trim().min(1).max(120), code: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(40), address: Address })
  .openapi('CreateCompanyLocationRequest');
export type CreateCompanyLocationRequest = z.infer<typeof CreateCompanyLocationRequest>;
export const UpdateCompanyLocationRequest = z
  .object({ version: Version, name: z.string().trim().min(1).max(120).optional(), address: Address.optional(), status: z.enum(['active', 'inactive']).optional() })
  .openapi('UpdateCompanyLocationRequest');
export type UpdateCompanyLocationRequest = z.infer<typeof UpdateCompanyLocationRequest>;

export const InviteBuyerRequest = z
  .object({
    email: Email,
    role: BuyerRole,
    locationIds: z.array(Uuid).max(50).nullable().default(null),
    orderLimitMinor: MinorAmount.nullable().default(null),
  })
  .openapi('InviteBuyerRequest');
export type InviteBuyerRequest = z.infer<typeof InviteBuyerRequest>;
export const InviteBuyerResponse = z
  .object({ buyer: CompanyBuyer, invitationToken: z.string(), invitationPath: z.string(), expiresAt: Timestamp })
  .openapi('InviteBuyerResponse');
export const UpdateBuyerRequest = z
  .object({
    version: Version,
    role: BuyerRole.optional(),
    locationIds: z.array(Uuid).max(50).nullable().optional(),
    orderLimitMinor: MinorAmount.nullable().optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .openapi('UpdateBuyerRequest');
export type UpdateBuyerRequest = z.infer<typeof UpdateBuyerRequest>;

// ---------------------------------------------------------------- credit ledger

export const CreditEntryType = z.enum(['order_charge', 'order_release', 'payment', 'advance', 'adjustment']);
export const CreditEntry = z
  .object({
    id: Uuid,
    type: CreditEntryType,
    /** + increases exposure (owed), − reduces it. */
    amountMinor: SignedMinor,
    reference: z.string().nullable(),
    orderId: Uuid.nullable(),
    note: z.string().nullable(),
    actor: ActorRef,
    createdAt: Timestamp,
  })
  .openapi('CreditEntry');
export type CreditEntry = z.infer<typeof CreditEntry>;
export const CreditEntryPage = pageOf(CreditEntry).openapi('CreditEntryPage');
export const RecordCreditEntryRequest = z
  .object({
    type: z.enum(['payment', 'advance', 'adjustment']),
    amountMinor: SignedMinor.refine((v) => v !== '0' && v !== '-0', 'Amount cannot be zero'),
    reference: z.string().trim().min(1).max(80),
    note: Reason,
  })
  .superRefine((r, ctx) => {
    if (r.type !== 'adjustment' && r.amountMinor.startsWith('-'))
      ctx.addIssue({ code: 'custom', path: ['amountMinor'], message: 'Payments and advances are positive amounts received' });
  })
  .openapi('RecordCreditEntryRequest');
export type RecordCreditEntryRequest = z.infer<typeof RecordCreditEntryRequest>;

// ---------------------------------------------------------------- RFQs

export const RfqStatus = z.enum(['submitted', 'quoted', 'accepted', 'declined', 'expired', 'cancelled']);
export const RfqMessage = z
  .object({ id: Uuid, author: z.enum(['buyer', 'staff']), authorName: z.string(), body: z.string(), createdAt: Timestamp })
  .openapi('RfqMessage');
export const Rfq = z
  .object({
    id: Uuid,
    number: z.string(),
    status: RfqStatus,
    company: z.object({ id: Uuid, name: z.string() }),
    buyer: z.object({ id: Uuid, name: z.string(), email: z.string() }),
    locationId: Uuid.nullable(),
    lines: z.array(QuoteLineInput.and(z.object({ note: z.string().nullable().optional() }))),
    /** Readable view of the lines. */
    items: z.array(z.object({ sku: z.string(), title: z.string(), serialTag: z.string().nullable(), quantity: z.number().int(), note: z.string().nullable() })),
    note: z.string().nullable(),
    neededBy: Timestamp.nullable(),
    quotationId: Uuid.nullable(),
    messages: z.array(RfqMessage),
    createdAt: Timestamp,
    version: Version,
  })
  .openapi('Rfq');
export type Rfq = z.infer<typeof Rfq>;
export const RfqSummary = Rfq.pick({ id: true, number: true, status: true, company: true, quotationId: true, createdAt: true })
  .extend({ lineCount: z.number().int(), buyerName: z.string() })
  .openapi('RfqSummary');
export const RfqPage = pageOf(RfqSummary).openapi('RfqPage');
export const RfqListQuery = PageQuery.extend({ status: RfqStatus.optional(), companyId: Uuid.optional() });
export type RfqListQuery = z.infer<typeof RfqListQuery>;
export const RfqMessageRequest = z.object({ body: z.string().trim().min(1).max(2000) }).openapi('RfqMessageRequest');
export type RfqMessageRequest = z.infer<typeof RfqMessageRequest>;
export const QuoteRfqRequest = z
  .object({
    version: Version,
    validUntil: z.string().datetime(),
    /** Optional replacement lines (e.g. a different design offered); defaults to the requested lines. */
    lines: z.array(QuoteLineInput).min(1).max(50).optional(),
    notes: z.string().trim().max(1000).nullable().default(null),
  })
  .openapi('QuoteRfqRequest');
export type QuoteRfqRequest = z.infer<typeof QuoteRfqRequest>;
export const DeclineRfqRequest = z.object({ version: Version, reason: Reason }).openapi('DeclineRfqRequest');
export type DeclineRfqRequest = z.infer<typeof DeclineRfqRequest>;

// ---------------------------------------------------------------- buyer portal

export const BuyerLoginRequest = z.object({ email: Email, password: z.string().min(1).max(128) }).openapi('BuyerLoginRequest');
export type BuyerLoginRequest = z.infer<typeof BuyerLoginRequest>;
export const BuyerContext = z
  .object({
    user: z.object({ id: Uuid, email: z.string(), displayName: z.string() }),
    storefront: z.object({ name: z.string(), currency: CurrencyCode, isDemo: z.boolean() }),
    companies: z.array(z.object({ id: Uuid, name: z.string(), role: BuyerRole })),
    company: z
      .object({
        id: Uuid,
        name: z.string(),
        role: BuyerRole,
        status: CompanyStatus,
        paymentTerms: z.enum(['prepaid', 'on_account']),
        minOrderMinor: MinorAmount.nullable(),
        orderLimitMinor: MinorAmount.nullable(),
        locations: z.array(CompanyLocation.pick({ id: true, name: true, code: true, address: true })),
        credit: CreditSummary,
      })
      .nullable(),
    sessionExpiresAt: Timestamp,
  })
  .openapi('BuyerContext');
export type BuyerContext = z.infer<typeof BuyerContext>;

export const BuyerInvitationPreview = z
  .object({ email: z.string(), companyName: z.string(), storefrontName: z.string(), role: BuyerRole, userExists: z.boolean(), expiresAt: Timestamp })
  .openapi('BuyerInvitationPreview');
export const AcceptBuyerInvitationRequest = z
  .object({
    token: z.string().min(20).max(200),
    displayName: z.string().trim().min(1).max(120).optional(),
    /** New password for a new account, or the current password of an existing account. */
    password: z.union([Password, z.string().min(1).max(128)]),
  })
  .openapi('AcceptBuyerInvitationRequest');
export type AcceptBuyerInvitationRequest = z.infer<typeof AcceptBuyerInvitationRequest>;

export const BuyerProduct = z
  .object({
    productId: Uuid,
    title: z.string(),
    variants: z.array(z.object({ id: Uuid, sku: z.string(), title: z.string(), moq: z.number().int().nullable() })),
  })
  .openapi('BuyerProduct');
export const BuyerCatalogQuery = PageQuery.extend({ q: z.string().trim().max(100).optional() });
export type BuyerCatalogQuery = z.infer<typeof BuyerCatalogQuery>;
export const BuyerCatalogPage = pageOf(BuyerProduct).openapi('BuyerCatalogPage');

/** Bulk entry: SKU (or SKU + piece tag) and pieces. */
export const BulkLine = z.object({
  sku: z.string().trim().min(1).max(80),
  serialTag: z.string().trim().max(60).nullable().default(null),
  quantity: z.number().int().min(1).max(100_000),
});
export const BuyerPriceRequest = z.object({ lines: z.array(BulkLine).min(1).max(200), locationId: Uuid.nullable().default(null) }).openapi('BuyerPriceRequest');
export type BuyerPriceRequest = z.infer<typeof BuyerPriceRequest>;
export const BuyerPriceResponse = z
  .object({
    quoteId: Uuid,
    currency: CurrencyCode,
    totalMinor: MinorAmount,
    expiresAt: Timestamp,
    lines: z.array(z.object({ sku: z.string(), title: z.string(), quantity: z.number().int(), totalMinor: MinorAmount, components: z.array(z.object({ label: z.string(), amountMinor: MinorAmount })) })),
    problems: z.array(z.object({ line: z.number().int(), code: z.string(), message: z.string() })),
    notes: z.array(z.string()),
  })
  .openapi('BuyerPriceResponse');
export type BuyerPriceResponse = z.infer<typeof BuyerPriceResponse>;

export const BuyerPlaceOrderRequest = z
  .object({
    quoteId: Uuid,
    acknowledgedTotalMinor: MinorAmount,
    locationId: Uuid,
    poNumber: z.string().trim().max(60).nullable().default(null),
    note: z.string().trim().max(1000).nullable().default(null),
  })
  .openapi('BuyerPlaceOrderRequest');
export type BuyerPlaceOrderRequest = z.infer<typeof BuyerPlaceOrderRequest>;

export const BuyerOrder = OrderSummary.extend({
  poNumber: z.string().nullable(),
  location: z.object({ id: Uuid, name: z.string() }).nullable(),
  placedBy: z.string().nullable(),
  lines: z.array(z.object({ sku: z.string(), title: z.string(), serialTag: z.string().nullable(), quantity: z.number().int(), totalMinor: MinorAmount })),
  approvalNote: z.string().nullable(),
}).openapi('BuyerOrder');
export type BuyerOrder = z.infer<typeof BuyerOrder>;
export const BuyerOrderPage = pageOf(OrderSummary).openapi('BuyerOrderPage');
export const BuyerOrderListQuery = PageQuery.extend({ status: z.string().max(40).optional() });
export type BuyerOrderListQuery = z.infer<typeof BuyerOrderListQuery>;
export const BuyerDecisionRequest = z.object({ note: z.string().trim().max(500).optional(), reason: z.string().trim().max(500).optional() }).openapi('BuyerDecisionRequest');
export type BuyerDecisionRequest = z.infer<typeof BuyerDecisionRequest>;

export const BuyerRfqRequest = z
  .object({
    locationId: Uuid.nullable().default(null),
    lines: z.array(BulkLine.extend({ note: z.string().trim().max(300).nullable().default(null) })).min(1).max(100),
    note: z.string().trim().max(2000).nullable().default(null),
    neededBy: z.string().datetime().nullable().default(null),
  })
  .openapi('BuyerRfqRequest');
export type BuyerRfqRequest = z.infer<typeof BuyerRfqRequest>;

export const BuyerQuotation = z
  .object({
    id: Uuid,
    number: z.string(),
    status: z.string(),
    rfqId: Uuid.nullable(),
    validUntil: Timestamp,
    currency: CurrencyCode.nullable(),
    totalMinor: MinorAmount.nullable(),
    lines: z.array(z.object({ index: z.number().int(), sku: z.string(), title: z.string(), quantity: z.number().int(), totalMinor: MinorAmount })),
    notes: z.string().nullable(),
    orderId: Uuid.nullable(),
  })
  .openapi('BuyerQuotation');
export type BuyerQuotation = z.infer<typeof BuyerQuotation>;
export const BuyerAcceptQuotationRequest = z
  .object({
    /** Indexes of the quoted lines to accept (partial acceptance); all lines when omitted. */
    lineIndexes: z.array(z.number().int().min(0)).min(1).max(50).optional(),
    locationId: Uuid,
    poNumber: z.string().trim().max(60).nullable().default(null),
  })
  .openapi('BuyerAcceptQuotationRequest');
export type BuyerAcceptQuotationRequest = z.infer<typeof BuyerAcceptQuotationRequest>;

