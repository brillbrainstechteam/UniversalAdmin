# Blocked dependencies (waiting on third parties or decisions)

The same list is shown in the app (Integrations → "Blocked dependencies"); its source is
`BLOCKED_DEPENDENCIES` and `CONNECTORS` in `packages/contracts/src/connectors.ts`. Nothing below is simulated as
if it were real. Update this file and that constant together when an item is unblocked.

| Area | Item | Waiting for | Phase | What works meanwhile |
|---|---|---|---|---|
| ERP | TallyPrime live connector | Pilot merchant running TallyPrime; their TDL/UDF field names for weights, purity, HUID, tag no.; sample Stock Summary + Stock Item export (dummy data); confirmation of closing stock per godown on a real install | 05+ | CSV/XLSX file import of a Tally export |
| ERP | Jwelly ERP API connector | API docs or export-feed spec, sandbox credentials, field dictionary, write-back confirmation (MMI Software) | 05+ | CSV/XLSX file import |
| ERP | Acme Infinity API connector | E-commerce interface docs (HMAC auth), supported editions, test company, image export format | 05+ | CSV/XLSX file import |
| ERP | Jewels Prime API connector | Enterprise API docs, Excel templates, trial access, weight/media export confirmation | 05+ | CSV/XLSX file import (their Excel formats) |
| ERP | Desktop agent (on-premise pull) | A confirmed local-software pilot, then build + security review | 05/11 | File import |
| ERP | Product images/videos from ERPs | Vendors to confirm their media export format | 05+ | Manual upload on the product page |
| ERP | Signed inbound webhooks (/v1/integrations) | A vendor that can push change events | 11 | Pull / file import |
| Pricing | Live metal-rate feed (`licensed_feed` provider) | Signed data licence, API docs + sandbox credentials, confirmed metals/purities/unit/currency/market | 06 | Manual rates with maker-checker; simulator for testing (labelled SIMULATED) |
| Payments | Payment gateway (real PSP) | Gateway account, sandbox keys, webhook signing secret | 07/09 | Sandbox gateway (signed callbacks, no real money, disabled in production) |
| Shipping | Courier tracking | Courier / aggregator account + API keys | 09/11 | — |
| Tax | GST/HSN rates and invoice format | Accountant validation of configured rules | 06/07 | Configurable rules flagged "pending validation" |
| B2B | GSTIN verification / e-invoicing | GST Suvidha Provider (GSP) access + accountant/legal sign-off | 08 | GSTIN format check only, labelled "not verified" |
| B2C | E-mail/SMS delivery, e-mail verification, password reset | A notification provider account (e-mail/SMS/WhatsApp) + approved templates | 09/11 | Messages recorded as "not sent"; accounts usable unverified |
| B2C | Courier labels and live tracking | Courier/aggregator account + API keys | 09/11 | Carrier and tracking number typed by staff, labelled "not tracked" |
| B2C | Invoices / credit notes | Accountant validation of GST invoice format | 09 | Order record and refund history only |
| B2B | ERP outstanding balances / credit | A live ERP adapter (see ERP rows) exposing receivables per customer | 08 | Commerce-side credit ledger; ERP-authority companies show "not synced" |

Vendor outreach drafts: [VENDOR-OUTREACH.md](VENDOR-OUTREACH.md). Research: [ERP-VENDOR-RESEARCH.md](ERP-VENDOR-RESEARCH.md).
Per-tenant discovery status is recorded in the app (Integrations → vendor card → Discovery checklist).
