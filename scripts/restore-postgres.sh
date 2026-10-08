#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_FILE:?BACKUP_FILE is required}"

if [[ "${ALLOW_RESTORE:-0}" != "1" ]]; then
  echo "[restore] blocked: set ALLOW_RESTORE=1 explicitly"
  exit 2
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "[restore] backup not found: $BACKUP_FILE"
  exit 3
fi

if [[ -f "$BACKUP_FILE.sha256" ]]; then
  sha256sum -c "$BACKUP_FILE.sha256"
fi

pg_restore "$BACKUP_FILE"   --dbname="$DATABASE_URL"   --clean   --if-exists   --no-owner   --no-acl

echo "[restore] completed"
