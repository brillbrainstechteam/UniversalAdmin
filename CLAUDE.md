# CLAUDE.md — authoritative build instructions
You are the lead engineer delivering a production-oriented reusable multi-tenant headless commerce platform. Read ALL files in README order. Do not interpret screenshots as functioning requirements. Follow phase gates. Build working end-to-end vertical slices (UI + API + DB + jobs + tests), not mock dashboards. No fabricated ERP integrations, payment successes, live metal rates, statutory tax correctness, or shipping tracking.

## Non-negotiable priorities
- One shared codebase, configurable B2B jewellery, B2C jewellery, hybrid and general-commerce merchant profiles; independent branded storefronts; single merchant admin with feature-gated navigation; separate platform super-admin.
- Product ≠ variant ≠ serialized inventory item. Stock ≠ price ≠ catalog visibility. Canonical decimal weights and money; explicit units; tenant-scoped IDs.
- Authoritative field ownership per merchant/connector; versioned ERP mappings; transactional reservations; immutable stock ledger; idempotent processing; conflict reconciliation; never promise zero oversell on periodic import-only sources.
- Price quote server-calculated, time-limited, revalidated on checkout, and immutable financial/rate/formula snapshot at finalization. No browser-controlled payable totals.
- API-first, modular monolith NestJS with workers; Next.js admin and storefronts, TypeScript strict, PostgreSQL, Redis/BullMQ, S3-compatible storage. Use OpenAPI; migration-tested DB; shared UI and schemas. If current repo contains a coherent compatible stack, preserve it and record deviations in ADRs.
- All public, merchant and platform APIs enforce scope and permissions. Fail closed, default deny; signed/idempotent webhooks and secure vault/secret references; no secrets in logs; audited sensitive changes.
- Tax, GST/HSN, invoice format, BIS/HUID and rate provider policy are configurable pending qualified validation, never hardcoded legal advice. A price-feed must be licensed, authenticated and carry timestamp/unit/currency/source; manual mode available. Demo data visibly labeled.

## Working protocol EACH phase
1. Inspect repository, dependency state, migrations, current tests. Summarize changes and risks, write plan in `docs/implementation/phase-XX.md` with tasks and acceptance cases.
2. Build only requested phase and its prerequisites; maintain architecture dependency boundaries. No unrelated rewrites; avoid placeholder click targets, fake persisted status, silently swallowed errors, or disabled security for development.
3. Generate/update schemas, migration, API/OpenAPI, tests, UI, seed demo data, docs and .env.example together.
4. Run format/lint/typecheck/unit/integration/e2e as available; show exact commands, exit results, coverage of acceptance cases. If missing environment/vendor credentials: implement adapter contract and local deterministic simulator; explicitly mark blocked live test.
5. Audit tenant scoping, authorization, idempotency, decimal precision, transitions, transaction boundaries, and rollback. Update progress and decision log. Commit only if permitted by user; never push/deploy without instruction.
6. STOP and request approval before next phase. If context constrained, record self-contained checkpoint in docs and stop.

## Deliverable checklist
[ ] Real navigable admin screens, responsive + keyboard accessible; tables with server pagination/filter/sort, saved views where specified, loading/empty/error/permission states.
[ ] DB migration and seed, typed DTO, server validation, RBAC, audit and tests.
[ ] APIs versioned, OpenAPI updated; background jobs with retry/DLQ/reconciliation where relevant.
[ ] No cross-tenant IDOR, no unsanitized customer or connector secrets, never use floating point for money/weight.
[ ] Functional vertical slice demonstrated with reproducible instructions; no claims of unsupported vendor capabilities.

## Engineering definition of done
All P0 scenarios in `qa/ACCEPTANCE-TESTS.md` relevant to phase pass with actual assertions. Each task must specify user, trigger, precondition, behavior, state transitions, permissions, errors, audit, test. No module considered done merely because its pages exist.
