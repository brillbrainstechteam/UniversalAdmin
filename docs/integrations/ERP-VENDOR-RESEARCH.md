# Jewellery ERP integration research (input for Phase 05 CONNECTORS)

Researched 2026-10-19 from public vendor pages only. No vendor accounts, sandboxes or private docs were used.
Anything marked *claim* is marketing text, not a technical specification. Nothing here may be built as a
"live" connector until the vendor supplies documentation and test credentials (OD-9, CLAUDE.md: no fabricated
ERP integrations).

## Summary

| Vendor | Public integration documentation | What can be built now | Images / videos from the ERP | Weights (g) and qty |
|---|---|---|---|---|
| **TallyPrime** (Tally Solutions) | **Yes**: XML over HTTP, and JSON from TallyPrime 7.0 (HTTP server, default port 9000) | A real read adapter for stock item masters, plus voucher import (sales) through a local agent next to Tally | **No**: no image or video fields in the stock item tags | Quantities in the item's unit (simple or compound units). No documented gross/net/purity fields: these depend on how the merchant set up items (often custom TDL or UDFs) |
| **Jwelly ERP** (MMI Software, Mathura) | **None found.** The site lists a Website module, Mobile App, Cataloging and "Tally integration" | CSV/Excel import using our mapping tool. API only after the vendor supplies docs | *Claim:* "Sync updated catalogs across the website and mobile app" (their own website module), with AI background removal of photos | *Claim:* "Barcode & purity tracking", "accurate weight calculations", "Stock Management by Poly & Box with Multiple Weights" |
| **Acme Infinity** (Satara) | **None.** "API" is marketing only. Exports go to Excel/PDF, and XML to Tally | CSV/Excel import. API only after the vendor supplies docs | *Claim:* "Images of all shop items on web", "Direct Image capture from TWIN camera" | *Claim:* "Direct weight from weighting scale"; branch metal rates per barcode. No HUID/purity sync fields are mentioned |
| **Jewels Prime** (Jewels Infosystems, Jaipur) | **None.** "API access & integrations" is listed only under the ENTERPRISE plan | Excel import (their documented formats), plus API only after the vendor supplies docs | Not mentioned | *Claim:* SKU, stock, RFID, purity, HUID/BIS hallmarking, diamond certificates. Gross/net weight is not mentioned |

**Bottom line:** of the four, only TallyPrime publishes integration documentation. For Jwelly, Acme Infinity and
Jewels Prime, a full catalogue + stock + images/videos sync **cannot be specified from public material**. Each
vendor has to provide an API spec or an export feed. Until then the realistic path is scheduled **file-based
import** (Excel/CSV, plus a ZIP or URL list for media), which Phase 05 already plans as the generic connector.

---

## 1. TallyPrime: documented, buildable

Sources: [Integration using XML](https://help.tallysolutions.com/xml-integration/) ·
[Integration using JSON](https://help.tallysolutions.com/tally-prime-integration-using-json-1/) ·
[Sample XML](https://help.tallysolutions.com/sample-xml/) ·
[Pre-requisites](https://help.tallysolutions.com/pre-requisites-for-integrations/) ·
[Integration initiated from TPAs](https://help.tallysolutions.com/integration-initiated-from-tpas/) ·
[Getting started](https://help.tallysolutions.com/getting-started-with-tally-integrations/) ·
[Jewellery page](https://tallysolutions.com/accounting-software/jewellery/)

**Transport**
- TallyPrime runs an HTTP server (F1 → Settings → Advanced Configuration → HTTP Server; or Exchange → Data
  Synchronization). The default port is 9000. Requests are `POST` to `http://<tally-host>:9000`, and at least one
  company must be loaded.
- XML envelope: `ENVELOPE / HEADER (VERSION, TALLYREQUEST = Export|Import|Execute, TYPE = Data|Collection|Object|Function, ID) / BODY / DESC (STATICVARIABLES, FETCHLIST, TDL)`.
  Responses carry `STATUS` (1 = ok).
- JSON (TallyPrime 7.0+): the header fields become HTTP headers (`tallyrequest`, `type`, `id`, `version`). Send
  `svCurrentCompany` every time, or data may be exchanged with the wrong company.
- **Security:** the docs describe no authentication or TLS for the listener, and every example uses
  `localhost`. **Never expose port 9000 to the internet.** Our design needs a small **on-premise agent** (or Tally
  on the merchant's cloud VM) that polls Tally locally and pushes signed, idempotent batches to our API. A
  "Secure WebSocket Integration" page exists in the Tally docs and is to be reviewed before Phase 05 build.

**Reading catalogue and stock**
- All stock items: `TALLYREQUEST Export, TYPE Data, ID "List of Accounts"` with static variable
  `AccountType = Stock Items`, or `TYPE Collection, ID StockItem` (JSON headers shown in the docs).
- Documented stock item fields: `NAME`, alias (`NAME.LIST`), part number (`MAILINGNAME.LIST`), `PARENT` (stock group),
  `BASEUNITS`, `ADDITIONALUNITS`/`CONVERSION` (compound units), price lists, `OPENINGBALANCE/RATE/VALUE`, `GODOWN`,
  batches. Tally keeps a master ID per object. The docs recommend mapping your own SKU via **alias or part number**.
- **Closing quantity per godown is not shown in the public samples.** The docs say to export a sample master or use
  a custom TDL report/collection (`<TDL><TDLMESSAGE>`). The stock summary report name must be confirmed in
  TallyPrime Developer ("Jump to Definition"). → Verification task for Phase 05 with a real Tally install.

**Writing back**
- Masters: `Import Data / All Masters` (create or alter stock items, units, godowns).
- Vouchers: `Import Data / Vouchers`, for example a Sales voucher with `ALLINVENTORYENTRIES.LIST` and
  `BATCHALLOCATIONS.LIST` (godown, batch). Responses report `CREATED / ALTERED / ERRORS / LASTVCHID`. Sales
  *Order* import is not shown in public samples.

**Jewellery data in Tally:** the jewellery page only says "Inventory by weight/purity", "Track by purity",
"Hallmarking", "Barcodes and tagging". Standard Tally has no gross/net/stone/fine weight or HUID fields. Merchants
usually add them through a **Tally partner's TDL customisation**, so the field names differ per merchant. Our connector
therefore needs a **per-merchant field mapping** (ADR: versioned mappings), and must not assume fixed tags.

**Media:** Tally does not store product images or videos. They must come from another source (file
upload, image URL column, or the merchant's DAM/website).

## 2. Jwelly ERP (MMI Software Pvt. Ltd.)

Source: [jwelly.com](https://www.jwelly.com/) (read in a browser. Automated fetching failed on the site's TLS
certificate chain.) Third-party listing: [SoftwareSuggest](https://www.softwaresuggest.com/jwelly).

- Modules listed: Inventory ("Barcode & purity tracking… real-time inventory updates"), **Website** ("Online
  showroom, product inquiries"), **Mobile App**, **Cataloging** ("Create beautiful product catalogs from raw
  images"; AI background removal; "Sync updated catalogs across the website and mobile app"), RFID, Bullion,
  Tally integration, "Export reports in Excel/PDF".
- Deployment: "Cloud & Desktop … install on-premise"; "Works both Online & Offline".
- **No API, webhook, feed or developer documentation is published.** The catalogue sync it describes is to
  Jwelly's *own* website and app.
- Contact: sales@jwelly.com · +91 99271 48990 · Support +91 80353 76564 · WhatsApp +91 80776 92732.

## 3. Acme Infinity

Sources: [jewellery-wholesaler](https://acmeinfinity.com/jewellery-wholesaler/),
[Jewel Corp on cloud](https://acmeinfinity.com/wholesaler-jewel-corp-on-cloud/), [FAQ](https://acmeinfinity.com/faq/),
[home](https://acmeinfinity.com/). Third-party listing: [SoftwareSuggest](https://www.softwaresuggest.com/acme-infinity).

- Jewel Corp (enterprise) claims: "Application Program Interface (API) provides you, self serving advantages",
  "E-commerce interface", "Interface with third party e-commerce tools", "Data import-export with market
  places", "Images of all shop items on web", "Item sales are auto reflected online & in store", "E-catalogue for
  online ordering", "HMAC, Multi-Factor Authentication".
- Exports documented: Excel/PDF reports; vouchers to XML for Tally.
- Stack (FAQ, possibly the older desktop edition): Clarion, C/C++, MySQL, Windows. Cloud and on-premise editions exist.
- A review on SoftwareSuggest lists "No Api Data Sync" as a con. It is several years old.
- **No public API documentation, no named e-commerce platforms.**
- ⚠ The home page currently contains injected gambling spam links, which suggests the site is compromised. Don't download files
  from it. Get documents from the vendor directly.
- Contact: sales@acmeinfinity.com, info@acmeinfinity.com · +91 2162 247046 / 248901.

## 4. Jewels Prime (Jewels Infosystems)

Source: [jewelsprime.com](https://www.jewelsprime.com/) (single page).

- "Jewels® Prime can be directly connected with your B2B or B2C ecommerce website to upload the latest products
  and new designs in stock. New orders can also be synced directly with your jewellery software."
- "API access & integrations" and "eCommerce storefront" appear only in the ENTERPRISE plan. No details.
- "Export to Excels | Import from Excels". Specific Excel formats exist for "diamond and stone inventory,
  jewellery stock, orders".
- Features mentioned: unique SKU codes, RFID ("Live RFID Sync"), metal purity, HUID/BIS hallmarking, diamond
  certificates. **Gross/net weight, images and videos are not mentioned.**
- Deployment: client-server on Windows, can be hosted on a cloud Windows server.
- Contact: info@jewelsinfosystems.com · +91 141 403 1313 · tickets: jewelsconnect.com.

---

## What to ask each vendor (send before Phase 05 build)

1. API reference (REST/SOAP/XML/ODBC) or a scheduled export feed: format, field dictionary, sample files.
2. Authentication (API key / OAuth / HMAC), IP allow-listing, rate limits, sandbox or test company.
3. **Catalogue:** design/style no., SKU/tag no., barcode/RFID EPC, category, metal, purity/karat/fineness,
   gross / net / stone / fine weight (unit and decimals), pieces, stone details (type, count, carat,
   certificate), HUID, making/wastage charges, status (in stock / sold / on approval).
4. **Stock:** per tag (unique piece) vs per design (qty and/or grams), per branch/godown, with a timestamp or version
   for incremental sync; deletions and sold pieces.
5. **Media:** whether images/videos are stored. How to fetch them (URL, binary endpoint, export folder), size and
   format, primary image flag, piece-level vs design-level media.
6. Change notifications (webhooks) or "modified since" queries. Snapshot frequency limits.
7. Order write-back: can we create an order/reservation/sale in the ERP, and does the ERP then reduce stock?
8. Which system is authoritative for price, stock and content (field ownership, ADR-002/OD-3).

## How this maps to our platform (Phase 05 plan input)

- **Connector framework (Phase 05):** adapter contract plus a deterministic **simulator** and a **file connector**
  (CSV/XLSX + media ZIP or image URL column), versioned field mappings, raw payload stored next to canonical values,
  snapshots with `as_of` (stale ones rejected, already built in Phase 04), reconciliation issues, and idempotent
  replays.
- **Piece-level jewellery (tag-wise stock)** maps to our serialized items (Phase 03): one tag = one serial item
  with actual gross/net/stone/fine grams, HUID, and stock state/location (Phase 04). **Design-level stock** maps to
  quantity balances in `pcs` or `g` (Phase 04 units).
- **Media** goes to S3 storage with the existing sniffing/size limits (Phase 02). Video support needs a new media type
  (MP4/WebM, size limit, poster frame). Planned as a Phase 05 sub-task, since none of the vendors document video
  export.
- **TallyPrime adapter:** buildable against a local TallyPrime test install (Educational mode works offline)
  via an on-prem agent. It will cover masters, quantity per godown and sales vouchers. Jewellery weight
  fields only through per-merchant TDL mapping.
- **Jwelly / Acme Infinity / Jewels Prime:** file connector with saved mapping presets, once a merchant shares a
  real export sample. A native API adapter only after the vendor's documentation and sandbox are received. Until then
  these are labelled "file import", never "live sync", and stock from periodic files is never promised as
  zero-oversell (ADR-018 / OD-3).
