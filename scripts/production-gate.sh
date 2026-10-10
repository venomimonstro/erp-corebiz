#!/usr/bin/env bash
set -euo pipefail

# Full local/server production gate. It never deploys and never targets
# production. The API and web smoke targets must be a LOCAL stack wired to the
# same explicitly disposable database used for migration replay.
required=(
  COREBIZ_DISPOSABLE_DATABASE_URL
  COREBIZ_SMOKE_BASE_URL
  COREBIZ_SMOKE_WEB_URL
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "[production-gate] BLOCKED: $name is required" >&2
    exit 1
  fi
done

if [[ "${COREBIZ_CONFIRM_DISPOSABLE_DB:-}" != "YES" ]]; then
  echo "[production-gate] BLOCKED: set COREBIZ_CONFIRM_DISPOSABLE_DB=YES only for a disposable DB" >&2
  exit 1
fi

if [[ -n "${DATABASE_URL:-}" && "${DATABASE_URL}" == "${COREBIZ_DISPOSABLE_DATABASE_URL}" ]]; then
  echo "[production-gate] BLOCKED: disposable DB must differ from DATABASE_URL" >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "[production-gate] BLOCKED: psql is required" >&2
  exit 1
fi

echo "[production-gate] 1/9 source + disposable migration release check"
bash scripts/release-check.sh

echo "[production-gate] 2/9 tenant RLS / runtime-role ownership gate"
psql "${COREBIZ_DISPOSABLE_DATABASE_URL}" -X -q -v ON_ERROR_STOP=1   -f scripts/security_tenant_rls_gate.sql

echo "[production-gate] 3/9 SECURITY DEFINER grant gate"
psql "${COREBIZ_DISPOSABLE_DATABASE_URL}" -X -q -v ON_ERROR_STOP=1   -f scripts/security_runtime_function_gate.sql

echo "[production-gate] 4/9 API business journey"
node scripts/smoke-user-journey.mjs

echo "[production-gate] 5/9 public commerce / booking diagnostics"
psql "${COREBIZ_DISPOSABLE_DATABASE_URL}" -X -q -v ON_ERROR_STOP=1   -f scripts/public_commerce_booking_diagnostics.sql

echo "[production-gate] 6/9 Finance / bank / Accounting reconciliation diagnostics"
psql "${COREBIZ_DISPOSABLE_DATABASE_URL}" -X -q -v ON_ERROR_STOP=1   -f scripts/finance_bank_reconciliation_diagnostic.sql
psql "${COREBIZ_DISPOSABLE_DATABASE_URL}" -X -q -v ON_ERROR_STOP=1   -f scripts/accounting_period_audit_reconcile.sql

echo "[production-gate] 7/9 WMS / 3PL reconciliation diagnostics"
psql "${COREBIZ_DISPOSABLE_DATABASE_URL}" -X -q -v ON_ERROR_STOP=1   -f scripts/wms_3pl_reconcile.sql
psql "${COREBIZ_DISPOSABLE_DATABASE_URL}" -X -q -v ON_ERROR_STOP=1   -f scripts/finance_3pl_reconcile.sql

echo "[production-gate] 8/9 browser journey"
node scripts/smoke-browser-journey.mjs

echo "[production-gate] 9/9 release-readiness structural diagnostics"
echo "[production-gate] NOTE: tenant-specific readiness diagnostics must be run with app.tenant_id set for each pilot tenant."
echo "[production-gate] PASS: disposable migration, security, API, browser and reconciliation gates completed."
echo "[production-gate] This command does not deploy. Production rollout still requires backup/restore evidence and operator approval."
