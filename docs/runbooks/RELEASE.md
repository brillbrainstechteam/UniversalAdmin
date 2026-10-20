# Release and rollback runbook (Phase 12)

## Before a release
- [ ] CI green on the release commit; OpenAPI baseline unchanged or the change is intended and documented.
- [ ] `PROGRESS.md` and the phase document list what changed, known issues and blocked dependencies.
- [ ] Every new migration has a row in `packages/db/migrations/ROLLBACK.md`; destructive steps are called out.
- [ ] A backup (or PITR marker) newer than one hour; `scripts/restore-drill.sh` passed within the last month.
- [ ] Merchants affected by behaviour changes are told in advance (e.g. new plan limits, new required steps).

## Release
1. Announce the window to platform operators.
2. Run migrations (`uc_owner`). They are additive: old code keeps working against the new schema.
3. Deploy `worker` and `api`; wait for `GET /health/ready` = 200 on every instance.
4. Deploy `merchant-admin`, `platform-admin`, `buyer-portal`, `storefront`.
5. Smoke: sign in to each app with the staging demo tenant; place a sandbox order; `psql -f scripts/invariants.sql`
   (all 0); platform console → Operations shows no new alerts.
6. Record the release (commit SHA, migrations applied, smoke result) in the platform audit or release log.

## Rollback
- **Code only** (no migration in the release): redeploy the previous image SHAs, worker first.
- **With migrations**: prefer rolling the code back and leaving the additive schema in place. Only run the
  `ROLLBACK.md` steps when the schema itself is the problem, after exporting data the rollback would destroy (each
  row says what to export).
- **Data damage**: follow `BACKUP-RESTORE.md` (restore into a new database, verify invariants, switch over).

## After a release
- Watch Operations (outbox backlog, webhook failures, ERP export lag, payment failures) for one hour.
- Close the release record with any follow-ups.
