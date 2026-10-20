# Incident response and support access (Phase 12)

## Severity
| Level | Examples | Response |
|---|---|---|
| SEV-1 | cross-tenant data exposure, wrong prices charged, payments recorded wrongly, data loss | page the on-call operator; stop the affected path (suspend the tenant, deactivate the channel, or block traffic at the load balancer — the API has no maintenance mode yet) |
| SEV-2 | checkout down for one or more merchants, ERP export stopped, webhooks dead for a merchant | fix or work around within the business day |
| SEV-3 | single page broken, slow report | normal backlog |

Alert routing (pager, e-mail, chat) is **not connected** yet (blocked: operator tooling). Until then operators check
platform console → Operations at the start of each shift and after every release.

## First steps
1. Note the time, symptoms, affected merchants and the correlation ID from the error message (every API error
   carries one; logs and audit events are searchable by it).
2. Contain: suspend a tenant (platform console → tenant → Suspend, reason required), pause a connection
   (Integrations → connection → Pause) or disable an automation/webhook.
3. Check Operations: outbox dead events (replay is safe — consumers deduplicate by event id), webhook failures,
   reconciliation issues, stale metal rates, payment failures.
4. Run `scripts/invariants.sql` read-only against the database; any non-zero row is a data incident.

## Looking at a merchant's admin (support access)
Operators never see a merchant's admin by default.
1. Platform console → tenant → **Support access** → *Request access*: reason (shown to the merchant), optional
   ticket reference, 15–120 minutes. The merchant's owners get an inbox notice.
2. An **owner** approves in Settings → Support access (admins cannot). The time starts at approval.
3. The requesting operator (only) clicks *Open merchant admin*: a one-time link valid for 60 seconds opens a
   **read-only** session for that merchant, with the viewer permissions minus customer personal data and the audit
   log. A red banner shows the reason and end time.
4. Every page viewed is written to the merchant's audit log (`support.request`), as are request, approval, denial,
   start and revocation. The owner sees the page count next to each request.
5. Either side ends it early (*End access*); the session stops on the next request. It also ends at expiry.
Changes on behalf of a merchant are made by the merchant's own staff; support sessions cannot write.

## After the incident
- Write a short report: timeline, cause, impact (merchants, orders, amounts), fix, follow-ups.
- Add a regression test for the cause before closing.
