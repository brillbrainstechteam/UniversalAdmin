#!/usr/bin/env bash
# Logical backup of one database from the local/dev Postgres container (Phase 11, docs/runbooks/BACKUP-RESTORE.md).
# Usage: scripts/backup.sh [database]   (default uc_dev). Writes backups/<db>-<UTC timestamp>.dump (pg_dump custom format).
# Production backups are a hosting concern (managed snapshots + WAL archiving / PITR); this script is the drill tool.
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${1:-uc_dev}"
COMPOSE="docker compose -f infra/docker-compose.yml"
mkdir -p backups
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="backups/${DB}-${STAMP}.dump"
$COMPOSE exec -T postgres pg_dump -U postgres --format=custom --no-password "$DB" > "$OUT"
SIZE="$(wc -c < "$OUT" | tr -d ' ')"
if [ "$SIZE" -lt 1024 ]; then
  echo "Backup looks empty ($SIZE bytes): $OUT" >&2
  exit 1
fi
SUM="$( (sha256sum "$OUT" 2>/dev/null || shasum -a 256 "$OUT") | cut -d' ' -f1)"
echo "$SUM  $(basename "$OUT")" > "$OUT.sha256"
echo "backup: $OUT ($SIZE bytes, sha256 $SUM)"
