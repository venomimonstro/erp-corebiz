#!/usr/bin/env bash
set -euo pipefail

# This script intentionally does NOT deploy, apply migrations to an operational
# database, or claim production readiness. Run migrations only on an explicitly
# selected, disposable staging database.
if [[ -z "${COREBIZ_DISPOSABLE_DATABASE_URL:-}" ]]; then
  echo "[release] BLOCKED: COREBIZ_DISPOSABLE_DATABASE_URL is required" >&2
  exit 1
fi

if [[ "${COREBIZ_CONFIRM_DISPOSABLE_DB:-}" != "YES" ]]; then
  echo "[release] BLOCKED: set COREBIZ_CONFIRM_DISPOSABLE_DB=YES after verifying the staging target" >&2
  exit 1
fi

if [[ -n "${DATABASE_URL:-}" && "${DATABASE_URL}" == "${COREBIZ_DISPOSABLE_DATABASE_URL}" ]]; then
  echo "[release] BLOCKED: staging migration database must differ from DATABASE_URL" >&2
  exit 1
fi

echo "[release] migration filename and RLS DDL preflight"
node scripts/migration-preflight.mjs

echo "[release] static typecheck"
pnpm typecheck

echo "[release] existing tests"
pnpm test

echo "[release] build"
pnpm build

echo "[release] migration replay on explicitly confirmed disposable DB"
DATABASE_URL="${COREBIZ_DISPOSABLE_DATABASE_URL}" pnpm db:migrate

echo "[release] automated source checks finished"
echo "[release] NOT PRODUCTION APPROVED: still require DB role/RLS, load, security, tenant, business workflow and backup/restore validation"
