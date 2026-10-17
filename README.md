# Universal Commerce OS — Claude Code Build Pack
Version 1.0 | Scope: reusable multi-tenant headless commerce platform, B2B/B2C jewellery presets, general-commerce extension.

## Read order
1. `CLAUDE.md` — mandatory execution rules and definition of done.
2. `specs/00-PRODUCT-AND-SCOPE.md` — objectives, personas, boundaries and success.
3. `specs/01-ARCHITECTURE.md` — system design and engineering choices.
4. `specs/02-DOMAIN-AND-DATA.md` — canonical entities and invariants.
5. `specs/03-MODULES-AND-UX.md` — end-to-end module requirements, page and action inventory.
6. `specs/04-JEWELLERY-PRICING.md` — units, metal rates, formula engine, locking.
7. `specs/05-ERP-INTEGRATIONS.md` — mapping, source of truth, safety and adapters.
8. `specs/06-OPERATIONS-SECURITY.md` — security, operations, tax and reliability.
9. `contracts/API-AND-EVENTS.md` — API and events contract.
10. `qa/ACCEPTANCE-TESTS.md` — test matrix and release gates.
11. `prompts/00-ORCHESTRATOR.md` and phase prompts 01–12 — use one at a time.

## Usage
Copy entire directory into the repository root. Start Claude Code at repository root with `prompts/00-ORCHESTRATOR.md`. Ask it to inspect the repo and execute only Phase 01, then review test output and approve successive phases. Do not ask it to build all phases in one unattended context. Commit after each green phase. Never send production secrets to Claude; store `.env.example` placeholders and secrets outside git.

## Scope marker
This is a detailed implementable PRD and work breakdown, not a claim of guaranteed third-party API availability, a certified tax/accounting implementation, or a substitute for vendor-specific interface documents. Vendor integrations are gated by verified access and tested mappings.

## Implementation status
Phase 01 (Foundation) implemented — see `docs/implementation/PROGRESS.md`.
Developer runbook: `docs/DEVELOPMENT.md` · API contract: `docs/api/openapi.json` · permission matrix: `docs/api/PERMISSIONS.md`.
