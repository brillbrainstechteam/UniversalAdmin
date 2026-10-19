# ERP vendor outreach: integration request drafts

Drafts for you to send from your own email. Fill in the `[brackets]`. Background is in
[ERP-VENDOR-RESEARCH.md](ERP-VENDOR-RESEARCH.md). Each email asks for the same core items (Annex A), so the
answers can be compared side by side in the connector capability matrix (specs/05).

Tips:
- Send it as a **mutual customer / partner** request. Vendors answer much faster when a named jeweller who uses their
  software is behind the request. If you have a pilot merchant on that ERP, name them (with their permission) and cc them.
- Ask for an NDA if they want one. Never accept production database credentials. We need an API, an export feed, or a
  test company or sandbox, not direct DB access (specs/05: "No direct unsanctioned production DB writes").
- Ask them to send sample files with **dummy data**, not real customer data.

---

## 1. Jwelly ERP (MMI Software Pvt. Ltd.)

**To:** sales@jwelly.com · **Phone:** +91 99271 48990 / support +91 80353 76564 · WhatsApp +91 80776 92732

**Subject:** Integration request: Jwelly ERP catalogue and stock sync with [Platform name] e-commerce

> Dear Jwelly team,
>
> We are building [Platform name], a multi-tenant B2B and B2C e-commerce platform for jewellers in India. Several
> jewellers we work with [e.g. *Merchant name, city*] use Jwelly ERP, and want their Jwelly stock to appear on
> their online store and wholesale portal automatically, without re-entering anything.
>
> Your website mentions a Website module, catalogue sync to website and mobile app, and Tally integration. We
> would like to integrate in the same way, with Jwelly remaining the master for stock, weights and tags.
>
> Could you please share:
> 1. Any API documentation (REST / SOAP / XML / ODBC) or a scheduled export feed (Excel/CSV/XML/JSON) that
>    third-party websites can use, with a field list and a sample file containing dummy data.
> 2. How a partner gets access: authentication method, test/demo company or sandbox, and any partner programme or
>    commercial terms.
> 3. The specific data points listed in the attached sheet (Annex A): tag-wise and design-wise stock, gross / net /
>    stone weight, purity, HUID, images and videos, and per-branch quantities.
> 4. Whether online orders can be written back into Jwelly (as an order, estimate or reservation), so stock is
>    reduced in Jwelly.
>
> We are happy to sign an NDA and to schedule a 30-minute technical call with your team.
>
> Regards,
> [Your name], [Designation]
> [Company] · [Phone] · [Website]

## 2. Acme Infinity

**To:** sales@acmeinfinity.com, cc info@acmeinfinity.com · **Phone:** +91 2162 247046 / 248901 · Mr. Nitin (Sales) 98505 63803

**Subject:** API / e-commerce interface for Acme Infinity Jewel Corp: technical documentation request

> Dear Acme Infinity team,
>
> We are developing [Platform name], an online sales platform (B2B wholesale portal and B2C store) for jewellers.
> Jewellers using Acme Infinity [e.g. *Merchant name*] want their items, images and live stock from Acme Infinity
> to appear online, and online orders to flow back into Acme Infinity.
>
> Your Jewel Corp pages mention an API with HMAC security, an "e-commerce interface", "interface with third party
> e-commerce tools", "Images of all shop items on web" and "Item sales are auto reflected online & in store". We
> would like to use that interface.
>
> Could you please share:
> 1. The API or e-commerce interface documentation: endpoints or export format, authentication (HMAC details), rate
>    limits, and a sample request/response or sample export with dummy data.
> 2. Which editions support it (Jewel Shop / Biz / Corp, cloud vs on-premise), and whether the on-premise edition
>    can push data out over HTTPS.
> 3. Answers to the data points in Annex A (barcode-wise stock, weights, purity, HUID, stones, images/videos,
>    branch stock, order write-back).
> 4. A test company or demo environment we can connect to, and any partner or commercial terms.
>
> We are happy to sign an NDA and set up a technical call.
>
> Regards,
> [Your name], [Designation]
> [Company] · [Phone] · [Website]

*Note for you:* Acme Infinity's public home page currently carries injected spam links. Ask them to send documents
by email. Don't download anything from their website.

## 3. Jewels Prime (Jewels Infosystems, Jaipur)

**To:** info@jewelsinfosystems.com · **Phone:** +91 141 403 1313 · Support tickets: jewelsconnect.com

**Subject:** Jewels Prime: API access and e-commerce integration documentation (partner request)

> Dear Jewels Infosystems team,
>
> We are building [Platform name], a B2B and B2C e-commerce platform for jewellers. Your site says Jewels Prime
> "can be directly connected with your B2B or B2C ecommerce website to upload the latest products and new designs
> in stock", that "New orders can also be synced", and lists "API access & integrations" in the Enterprise plan.
>
> We would like to connect Jewels Prime to our platform for jewellers who use both [e.g. *Merchant name*]. Could
> you please share:
> 1. The API documentation for the Enterprise plan (endpoints, authentication, rate limits, sample responses with
>    dummy data), or the export feed used for e-commerce websites.
> 2. Your Excel import/export formats for jewellery stock and orders. A blank template and a sample file would
>    help, so we can support file-based sync from day one.
> 3. Answers to the data points in Annex A, especially gross/net weight, images and videos, RFID/tag-wise stock and
>    HUID.
> 4. Access to a trial or test company, and the commercial terms for API access for a merchant on a lower plan.
>
> We are happy to sign an NDA and join a technical call.
>
> Regards,
> [Your name], [Designation]
> [Company] · [Phone] · [Website]

## 4. TallyPrime

Tally's integration interface **is publicly documented** (XML/JSON over HTTP, port 9000), so there is no need to ask
Tally Solutions for an API. What we need from a Tally-using jeweller is **their specific setup**: jewellery
weight/purity fields are usually added by a local **Tally partner** through TDL customisation. Send this to the
merchant and their Tally partner.

**To:** [Merchant's accountant / Tally partner] · cc: [Merchant owner]

**Subject:** Connecting your TallyPrime stock to [Platform name]: setup details needed

> Dear [Name],
>
> [Merchant name] would like their TallyPrime stock items and quantities to sync to their online store on
> [Platform name]. We use Tally's documented XML/JSON integration through a small agent installed on the Tally
> computer. The agent only reads data locally and sends it securely to us over HTTPS. No port is opened to the
> internet, and nothing is written into Tally without the merchant's approval.
>
> To set this up we need:
> 1. TallyPrime version and release, edition (Silver/Gold), and whether it runs on a local PC, a server, or
>    TallyPrime on cloud/AWS.
> 2. Whether any **TDL customisation or add-on** is installed for jewellery (gross / net / stone weight, purity,
>    making charges, HUID, tag number). If yes, the field (UDF) names, and who maintains the TDL.
> 3. How stock is kept: one stock item per design or per tag; units (Nos / Gms / compound units); godowns per
>    branch; batches.
> 4. Which field holds the SKU or tag number we should match on (Alias or Part No.).
> 5. A sample export (Stock Summary and Stock Item masters, in XML or Excel) from a **copy** of the company or a
>    test company with dummy data.
> 6. Whether online orders should be posted back into Tally, and as which voucher type (Sales Order / Sales /
>    Delivery Note).
>
> Product images and videos are not stored in Tally, so the merchant will upload those to the store separately.
>
> Regards,
> [Your name], [Designation]
> [Company] · [Phone]

---

## Annex A: technical questionnaire (attach to every email)

Please answer each point, or mark it "not supported".

**A. Access**
1. Integration method: REST / SOAP / XML / ODBC / file export (format?) / other.
2. Authentication; IP allow-listing; rate limits; test company or sandbox available?
3. Cloud and on-premise editions: does each support it? Can the on-premise edition send data out over HTTPS?
4. Commercial terms or partner programme for API access.

**B. Catalogue (design level)**
5. Design/style number, product name, category, collection, metal, purity/karat/fineness, description.
6. Design (nominal) weights; making/wastage charges and their basis (per gram / per piece / %).
7. Stable unique ID for each design that never changes or is reused.

**C. Stock (piece level and quantity)**
8. Tag-wise (each physical piece) or design-wise stock, or both?
9. Per piece: tag/barcode no., RFID EPC, HUID, gross / net / stone / fine weight (unit and decimals), pieces count,
   stone details (type, count, carat, quality, certificate no.), branch/godown, status (in stock / sold / on
   approval / in repair / transferred).
10. Per design: quantity (pcs) and/or weight (grams) per branch.
11. Incremental changes: "modified since" query, change log or webhooks? Are sold or deleted items reported?
12. How often can we pull a full stock snapshot, and does it carry a timestamp?

**D. Media**
13. Are product images or videos stored? At piece level or design level?
14. How can they be retrieved (URL, API endpoint, export folder)? Formats and sizes? Which one is the primary image?

**E. Orders and reservations (write-back)**
15. Can an external system create an order, estimate or reservation, and does it reduce or hold stock?
16. Is there an idempotency or reference field so a retried order is never duplicated?
17. Can we read the order status back (accepted / invoiced / cancelled)?

**F. Prices**
18. Is a selling price or metal rate stored per item or per branch? Should it be used online, or does the online
    store calculate prices itself?

**G. Samples**
19. Sample files or API responses with **dummy data** for items, stock and one order.
