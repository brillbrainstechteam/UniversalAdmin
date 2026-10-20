/**
 * Connector registry (Phase 05, specs/05 "honest support tiers"). A connector is only `available` when it has been
 * built AND tested end to end. Vendor connectors stay `blocked` until their documentation, sandbox credentials and a
 * pilot are in hand — the app lists exactly what each one is waiting for.
 */
export const CONNECTOR_TIERS = {
  file: 'Generic file import (CSV / Excel)',
  simulator: 'Deterministic simulator (testing and demos)',
  vendor_api: 'Vendor API connector',
  desktop_agent: 'Desktop agent next to on-premise software',
} as const;
export type ConnectorTier = keyof typeof CONNECTOR_TIERS;

export interface ConnectorCapabilities {
  importCatalog: boolean;
  importStock: boolean;
  importPieces: boolean;
  importMedia: boolean;
  importRates: boolean;
  pushOrders: boolean;
  webhooks: boolean;
}

export interface ConnectorDefinition {
  key: string;
  label: string;
  vendor: string;
  tier: ConnectorTier;
  status: 'available' | 'blocked';
  /** How data arrives; never advertised as real-time unless the source pushes changes. */
  freshness: string;
  capabilities: ConnectorCapabilities;
  /** What must arrive before this connector can be built and certified. */
  blockedOn: string[];
  /** Public sources used for the assessment. */
  references: { label: string; url: string }[];
  /** Meanwhile, merchants can use this connector instead. */
  fallback?: string;
}

const none: ConnectorCapabilities = {
  importCatalog: false,
  importStock: false,
  importPieces: false,
  importMedia: false,
  importRates: false,
  pushOrders: false,
  webhooks: false,
};

export const CONNECTORS: Record<string, ConnectorDefinition> = {
  file_csv: {
    key: 'file_csv',
    label: 'CSV / Excel file import',
    vendor: 'Any ERP or spreadsheet',
    tier: 'file',
    status: 'available',
    freshness: 'As fresh as the last uploaded file (manual upload). Not real-time.',
    capabilities: { ...none, importCatalog: true, importStock: true, importPieces: true },
    blockedOn: [],
    references: [],
  },
  simulator: {
    key: 'simulator',
    label: 'Demo ERP (simulator)',
    vendor: 'Built-in test double — not a real ERP',
    tier: 'simulator',
    status: 'available',
    freshness: 'Pulled on demand; changes advance only when you step the simulator.',
    capabilities: { ...none, importCatalog: true, importStock: true, importPieces: true, pushOrders: true },
    blockedOn: [],
    references: [],
  },
  tallyprime: {
    key: 'tallyprime',
    label: 'TallyPrime',
    vendor: 'Tally Solutions',
    tier: 'desktop_agent',
    status: 'blocked',
    freshness: 'Planned: polling through a local agent (minutes, not real-time).',
    capabilities: none,
    blockedOn: [
      'A merchant pilot running TallyPrime (version, edition, hosting confirmed)',
      'Merchant’s jewellery customisation details (TDL / UDF names for weights, purity, HUID, tag no.)',
      'Sample Stock Summary + Stock Item export from a test company (dummy data)',
      'Confirmation of the closing-stock-per-godown report on a real install',
      'Desktop agent build + security review (no inbound port; outbound HTTPS only)',
    ],
    references: [
      { label: 'Integration using XML', url: 'https://help.tallysolutions.com/xml-integration/' },
      { label: 'Integration using JSON', url: 'https://help.tallysolutions.com/tally-prime-integration-using-json-1/' },
    ],
    fallback: 'file_csv',
  },
  jwelly: {
    key: 'jwelly',
    label: 'Jwelly ERP',
    vendor: 'MMI Software Pvt. Ltd.',
    tier: 'vendor_api',
    status: 'blocked',
    freshness: 'Unknown until the vendor documents an API or export feed.',
    capabilities: none,
    blockedOn: [
      'API documentation or export-feed specification from MMI Software',
      'Sandbox / test company credentials',
      'Field dictionary incl. tag-wise weights, purity, HUID, images/videos',
      'Order write-back support confirmation',
    ],
    references: [{ label: 'jwelly.com', url: 'https://www.jwelly.com/' }],
    fallback: 'file_csv',
  },
  acme_infinity: {
    key: 'acme_infinity',
    label: 'Acme Infinity',
    vendor: 'Acme Infinity',
    tier: 'vendor_api',
    status: 'blocked',
    freshness: 'Unknown until the vendor documents its e-commerce interface.',
    capabilities: none,
    blockedOn: [
      'API / e-commerce interface documentation (HMAC auth details)',
      'Which editions support it (cloud / on-premise)',
      'Test company credentials',
      'Image export format',
    ],
    references: [{ label: 'acmeinfinity.com', url: 'https://acmeinfinity.com/jewellery-wholesaler/' }],
    fallback: 'file_csv',
  },
  jewels_prime: {
    key: 'jewels_prime',
    label: 'Jewels Prime',
    vendor: 'Jewels Infosystems',
    tier: 'vendor_api',
    status: 'blocked',
    freshness: 'Unknown until the vendor documents its Enterprise API.',
    capabilities: none,
    blockedOn: [
      'Enterprise plan API documentation',
      'Excel import/export templates (usable now through file import)',
      'Trial / test company access',
      'Gross/net weight and media export confirmation',
    ],
    references: [{ label: 'jewelsprime.com', url: 'https://www.jewelsprime.com/' }],
    fallback: 'file_csv',
  },
};
export const CONNECTOR_KEYS = Object.keys(CONNECTORS);

/** Platform-level items waiting on third parties or decisions (shown in the app and in the docs). */
export const BLOCKED_DEPENDENCIES: { area: string; item: string; waitingFor: string; phase: string }[] = [
  { area: 'ERP', item: 'TallyPrime live connector', waitingFor: 'Pilot merchant + TDL field details + sample export', phase: '05+' },
  { area: 'ERP', item: 'Jwelly ERP API connector', waitingFor: 'Vendor API docs + sandbox (email sent?)', phase: '05+' },
  { area: 'ERP', item: 'Acme Infinity API connector', waitingFor: 'Vendor interface docs + test company', phase: '05+' },
  { area: 'ERP', item: 'Jewels Prime API connector', waitingFor: 'Enterprise API docs + trial access', phase: '05+' },
  { area: 'ERP', item: 'Desktop agent (on-premise pull)', waitingFor: 'Confirmed local-software pilot', phase: '05/11' },
  { area: 'ERP', item: 'Product images/videos from ERPs', waitingFor: 'Vendors to confirm media export format', phase: '05+' },
  { area: 'ERP', item: 'Signed inbound webhooks (/v1/integrations)', waitingFor: 'A vendor that can push change events', phase: '11' },
  { area: 'Pricing', item: 'Live metal-rate feed', waitingFor: 'Licensed rate provider + credentials (manual rates until then)', phase: '06' },
  { area: 'Payments', item: 'Payment gateway', waitingFor: 'Gateway account + sandbox keys', phase: '07/09' },
  { area: 'Shipping', item: 'Courier tracking', waitingFor: 'Courier/aggregator account + API keys', phase: '09/11' },
  { area: 'B2C', item: 'E-mail/SMS delivery, e-mail verification, password reset', waitingFor: 'Notification provider account + approved templates (messages recorded as not sent)', phase: '09/11' },
  { area: 'Marketing', item: 'Campaign sending (e-mail/SMS/WhatsApp)', waitingFor: 'Notification provider account + approved templates (audiences prepared, not sent)', phase: '10/11' },
  { area: 'Marketing', item: 'Acquisition cost (CAC/ROAS)', waitingFor: 'Ad-spend import from ad platforms', phase: '10+' },
  { area: 'B2C', item: 'Invoices / credit notes', waitingFor: 'Accountant validation of GST invoice format', phase: '09' },
  { area: 'Tax', item: 'GST/HSN rates and invoice format', waitingFor: 'Accountant validation of configured rules', phase: '06/07' },
  { area: 'B2B', item: 'GSTIN verification / e-invoicing', waitingFor: 'GSP access + accountant/legal sign-off (format check only until then)', phase: '08' },
  { area: 'B2B', item: 'ERP outstanding balances / credit', waitingFor: 'A live ERP adapter exposing receivables per customer', phase: '08' },
];

/**
 * Phase 11 gateway providers behind the SDK interfaces (payment, shipping, notification). Status is what actually
 * exists in this build: `sandbox` = test double (no real money/messages), `blocked` = needs an account and keys.
 */
export const PROVIDERS: {
  kind: 'payment' | 'shipping' | 'notification';
  key: string;
  name: string;
  status: 'sandbox' | 'blocked' | 'not_configured';
  capabilities: string[];
  detail: string;
}[] = [
  { kind: 'payment', key: 'sandbox', name: 'Sandbox gateway', status: 'sandbox', capabilities: ['capture', 'refund', 'signed callbacks'], detail: 'Test double: no real money moves; refused in production.' },
  { kind: 'payment', key: 'card_gateway', name: 'Card / UPI gateway', status: 'blocked', capabilities: ['capture', 'refund', 'signed callbacks'], detail: 'Needs a gateway merchant account, sandbox keys and a webhook signing secret.' },
  { kind: 'shipping', key: 'courier_aggregator', name: 'Courier aggregator', status: 'blocked', capabilities: ['serviceability', 'rates', 'labels', 'tracking'], detail: 'Needs a courier/aggregator account and API keys. Until then carriers and tracking numbers are typed by staff.' },
  { kind: 'notification', key: 'email', name: 'E-mail delivery', status: 'blocked', capabilities: ['transactional e-mail', 'campaign e-mail'], detail: 'Needs an e-mail provider account and a verified sender domain. Messages are recorded as not sent.' },
  { kind: 'notification', key: 'sms', name: 'SMS', status: 'blocked', capabilities: ['transactional SMS', 'campaign SMS'], detail: 'Needs an SMS provider account and registered (DLT) templates.' },
  { kind: 'notification', key: 'whatsapp', name: 'WhatsApp Business', status: 'blocked', capabilities: ['template messages'], detail: 'Needs a WhatsApp Business account and approved templates.' },
];

