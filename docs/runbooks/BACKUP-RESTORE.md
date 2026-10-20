# Backup and restore runbook (Phase 11)

## What exists today
- `scripts/backup.sh [db]` — logical backup of one database from the Postgres container (`pg_dump` custom format)
  into `backups/<db>-<UTC stamp>.dump`, with a `.sha256` checksum file. `backups/` is git-ignored.
- `scripts/restore-drill.sh <dump> [source-db]` — verifies the checksum, restores into a scratch database
  `uc_restore_drill`, compares row counts of key tables with the source, runs `scripts/invariants.sql`, prints
  `DRILL PASSED` / `DRILL FAILED`, and drops the scratch database. It never writes to the source database.
- `scripts/invariants.sql` — read-only checks that must all report 0: negative stock balances, balances that differ
  from the stock ledger, a piece on two live orders, order totals that do not add up, refunds above the captured
  amount, discount usage that differs from redemptions, credit entries with the wrong sign. Safe to run against any
  environment (`psql -f scripts/invariants.sql`).

## Drills performed
| Date | Source | Dump size | Restore time | Row counts | Invariants |
|---|---|---|---|---|---|
| 2026-10-20 | `uc_dev` (migrated to 0022) | 474,839 B | 11 s | identical | 7/7 = 0 — PASSED |
| 2026-10-20 | `uc_test` (after the test suites) | 491,481 B | 11 s | identical | 7/7 = 0 — PASSED |

## Proposed objectives (to confirm with the operator in Phase 12)
- **RPO 15 minutes / RTO 1 hour** for the primary database, which needs managed Postgres with continuous WAL
  archiving (point-in-time recovery) plus daily snapshots kept 30 days. Logical dumps alone give RPO = time since
  the last dump.
- Object storage (product media) needs bucket versioning or replication; Redis holds only rate-limit counters,
  queues and caches — losing it delays events (the transactional outbox re-publishes them) but loses no business
  data.

## Restore procedure (production, once hosting is chosen)
1. Declare the incident; stop the worker and put the API in maintenance (no writes).
2. Restore the snapshot / PITR target into a **new** database; run `scripts/invariants.sql` and the row-count
   comparison against the last known figures.
3. Point `DATABASE_URL` / `DATABASE_OWNER_URL` at the restored database; run `pnpm db:migrate` (no-op if current).
4. Start the API, then the worker: the outbox relay publishes pending events; consumers dedupe by event id.
5. Check Operations (merchant and platform): outbox backlog draining, no dead events; reconcile ERP stock
   (Integrations → reconciliation) for activity after the restore point.
6. Record the drill/incident in this file.
