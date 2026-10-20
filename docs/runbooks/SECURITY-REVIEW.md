# Security review checklist (Phase 11)

Reviewed against specs/06 and the OWASP API Top 10. "Evidence" points to an automated test where one exists.

| Area | Control | Status | Evidence |
|---|---|---|---|
| Tenant isolation | Row-level security on every tenant table; `X-Tenant-Id` validated against membership on every request; other-tenant ids → 404/403 | In place | `packages/db/test/migrations.spec.ts` (RLS on all tables), isolation cases in every phase suite |
| Object-level authorization | Buyer company/location scope, customer ownership, sales-rep filter | In place | `b2b.spec.ts` B-02/B-08/B-10, `b2c.spec.ts` C-02 |
| Function-level authorization | Every admin route declares a permission (fail closed); platform routes separate | In place | `PermissionGuard` rejects routes without policy; viewer/role tests |
| Authentication | argon2id, throttling per IP and e-mail, lockout, uniform errors, opaque hashed sessions, idle timeout | In place | `auth.spec.ts`, `b2c.spec.ts` C-01 |
| MFA | TOTP for staff and operators, single-use codes, hashed recovery codes, challenge limited to 5 min / 5 attempts, merchant can require it for owners/admins | Added (Phase 11) | `ops.spec.ts` P-05, `e2e/tests/ops.spec.ts` |
| Machine access | Read-only API keys, hashed, scoped ⊆ creator, tenant-bound, expiring, revocable, last-used | Added (Phase 11) | `ops.spec.ts` P-04 |
| CSRF | Header + Origin checks for cookie APIs (admin, portal, storefront account); SameSite=Strict cookies | In place | `b2b.spec.ts` B-01, `b2c.spec.ts` C-01 |
| SSRF | Webhook URLs: https only, DNS-resolved and refused for private/loopback/link-local/metadata ranges; re-checked at delivery; no redirects followed | Added (Phase 11) | `ops.spec.ts` P-02 |
| Secrets | Connector credentials as secret-store references; webhook secrets and TOTP seeds AES-256-GCM sealed; shown once; dev keys refused in production | Added (Phase 11) | config unit tests, `ops.spec.ts` P-03 |
| Webhooks in | Payment callbacks HMAC-verified (timing-safe), replay-protected, amount-checked | In place | `orders.spec.ts` O-04, `b2c.spec.ts` C-08 |
| Webhooks out | Signed (`t=…,v1=…`), event id for dedupe, retries with backoff, dead-letter + replay | Added (Phase 11) | `ops.spec.ts` P-01/P-02 |
| Money integrity | Integer minor units, decimal library, DB checks, refund ≤ captured under lock, usage limits under lock | In place | pricing fixtures, C-08, G-07 |
| Audit | Append-only audit log for sensitive changes; immutable ledgers (stock, credit, consent, redemptions, versions) | In place | migration triggers + tests |
| Input validation | zod on every body/query/param; CSV export formula-injection guard; content links restricted to paths/https | In place | G-01, G-09, P-08 |
| Rate limiting | Login, storefront cart/checkout/pay, registration | Partial | Throttling fails open if Redis is down (availability over lockout) — documented; per-IP counts behind the Next.js proxies are the proxy's IP (Phase 12 deployment decision: trusted forwarded-for) |
| Headers | `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` on all Next apps | In place | `next.config.mjs` |
| Dependencies | `pnpm audit --audit-level high` clean (4 moderate, dev tooling) | In place | gate output |

## Open items (owner: Phase 12 / deployment)
- Content-Security-Policy for the Next.js apps (needs the final asset/CDN hosts).
- Trusted forwarded-for handling behind the proxies (per-client rate limits) and TLS termination.
- External penetration test before pilot; secrets in a managed vault with rotation.
