#!/usr/bin/env bash
# Restore drill (Phase 11): restores a backup into a scratch database, compares row counts with the source and runs
# the business invariants. Never touches the source database.
# Usage: scripts/restore-drill.sh backups/<db>-<stamp>.dump [source-db]   (source default uc_dev)
set -euo pipefail
cd "$(dirname "$0")/.."
DUMP="${1:?usage: scripts/restore-drill.sh <dump> [source-db]}"
SRC="${2:-uc_dev}"
DRILL="uc_restore_drill"
COMPOSE="docker compose -f infra/docker-compose.yml"
PSQL="$COMPOSE exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -X -q"

if [ -f "$DUMP.sha256" ]; then
  EXPECTED="$(cut -d' ' -f1 "$DUMP.sha256")"
  ACTUAL="$( (sha256sum "$DUMP" 2>/dev/null || shasum -a 256 "$DUMP") | cut -d' ' -f1)"
  [ "$EXPECTED" = "$ACTUAL" ] || { echo "checksum mismatch for $DUMP" >&2; exit 1; }
  echo "checksum ok"
fi

START="$(date +%s)"
$PSQL -d postgres -c "drop database if exists $DRILL" -c "create database $DRILL"
$COMPOSE exec -T postgres pg_restore -U postgres --no-password --exit-on-error -d "$DRILL" < "$DUMP"
END="$(date +%s)"
echo "restored into $DRILL in $((END - START)) s"

COUNTS="select 'tenants', count(*) from tenants union all select 'products', count(*) from products union all select 'orders', count(*) from orders union all select 'order_lines', count(*) from order_lines union all select 'stock_movements', count(*) from stock_movements union all select 'payments', count(*) from payments union all select 'audit_events', count(*) from audit_events order by 1"
SRC_COUNTS="$($PSQL -d "$SRC" -At -F' ' -c "$COUNTS")"
DRILL_COUNTS="$($PSQL -d "$DRILL" -At -F' ' -c "$COUNTS")"
echo "row counts (table source restored):"
paste -d' ' <(echo "$SRC_COUNTS") <(echo "$DRILL_COUNTS" | cut -d' ' -f2)
if [ "$SRC_COUNTS" != "$DRILL_COUNTS" ]; then
  echo "NOTE: counts differ — expected only if the source changed after the backup was taken" >&2
fi

echo "invariants on the restored database:"
RESULT="$($PSQL -d "$DRILL" -At -F'|' < scripts/invariants.sql)"
echo "$RESULT" | sed 's/^/  /'
if echo "$RESULT" | awk -F'|' '$2 != 0 { bad = 1 } END { exit bad ? 0 : 1 }'; then
  echo "DRILL FAILED: invariant violations" >&2
  exit 1
fi
echo "DRILL PASSED"
$PSQL -d postgres -c "drop database $DRILL"
