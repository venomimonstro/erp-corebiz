#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"

FILE="$BACKUP_DIR/corebiz-$STAMP.dump"

pg_dump "$DATABASE_URL"   --format=custom   --no-owner   --no-acl   --file="$FILE"

sha256sum "$FILE" > "$FILE.sha256"

echo "[backup] created $FILE"
echo "[backup] checksum $FILE.sha256"
