# Pilot readiness (Phase 12)

A pilot is one real merchant using the platform with an agreed scope, on the **Pilot** plan (no limits), with
platform operators watching closely. This page is the go/no-go checklist and the list of risks that remain.

## Go / no-go checklist
### Platform (operator)
- [ ] Hosting chosen and staging deployed per `STAGING-DEPLOY.md`; production environment variables pass the API's
      start-up checks.
- [ ] Backups with point-in-time recovery; a restore drill passed on staging (`BACKUP-RESTORE.md`).
- [ ] Operators have MFA turned on (platform console → My security).
- [ ] Alert routing decided (until then: Operations checked each shift).
- [ ] Release, incident and support-access procedures read by every operator (`RELEASE.md`,
      `INCIDENT-RESPONSE.md`).

### Merchant (in the merchant admin)
- [ ] Setup guide: all required steps done (it is computed from real records).
- [ ] Owners and admins have MFA; consider Settings → Security → *Require two-step verification*.
- [ ] Staff invited with the narrowest roles that work; location scopes set for branch staff.
- [ ] Metal rates entered and approved by two people (maker-checker) — no live rate feed is connected.
- [ ] Tax and invoice wording reviewed by the merchant's accountant: the platform does **not** certify statutory
      tax correctness.
- [ ] Payment method agreed: on account / quotation, or a real gateway once the provider account exists (blocked).

### Catalog and stock source
- [ ] File import or connector chosen; **Pilot readiness** card on the connection shows credentials, ownership,
      mapping, dry run, full import, incremental run, reconciliation clear and (for ERP connectors) an acknowledged
      test sale.
- [ ] "Production support" stays *blocked* until the vendor connector passes sandbox/pilot acceptance with the vendor
      (spec 05). File imports are the supported path until then.

### Exit criteria for the pilot (agreed with the merchant, measured — not invented)
Baseline first, then targets: time to provision, % products mapped, stock discrepancy count and age, order export
lag and success rate, checkout price mismatches (target 0), duplicate orders (target 0), cross-tenant access
incidents (target 0).

## Residual risks
| Risk | Effect | Mitigation now | Removes it |
|---|---|---|---|
| No vendor ERP connector certified | stock and orders move by file import / manual export | file import with preview, reconciliation issues, pilot checklist | vendor documentation, licence and sandbox access |
| No live metal-rate feed | rates are typed by staff | maker-checker approval, stale-rate alerts in Operations | licensed rate feed and credentials |
| No real payment gateway | online card/UPI payments impossible | sandbox only (refused in production), on-account / quotation orders | gateway merchant account and keys |
| No courier or notification providers | tracking numbers typed by staff; customer messages recorded, not sent | honest status in Integrations → Providers | provider accounts, sender domain, template approval |
| No billing | plans limit usage but charge nothing | plans carry no price; usage visible to both sides | billing provider and commercial terms |
| No alert routing | an operator must look at Operations | Operations health with thresholds; staff inbox | pager / e-mail / chat integration |
| No managed backups / PITR yet | RPO = time since last logical dump | backup + restore-drill scripts, invariants | hosting choice |
| Plan limits apply to staff-created records only | ERP sync can exceed product limits (by design: the merchant's system of record is never refused) | usage shows *over*; operator follows up | commercial policy decision |
| Support sessions use the merchant cookie name | an operator who is also a merchant member is signed out of that merchant in the same browser | use a separate browser profile for support | separate support origin (later) |
| Tax rules are configuration, not certified | wrong tax if configured wrongly | accountant review of the tax configuration before the pilot | professional review per jurisdiction |
| Performance measured on a developer machine | production latency unknown | baseline in phase-11 doc (5k products / 20k orders) | load test on staging hardware |
