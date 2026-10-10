#!/usr/bin/env bash
set -euo pipefail

# Full local/server production gate. It never deploys and never targets
# production. API/web targets must be LOCAL and both database URLs must point
# to explicitly disposable databases.
required=(
  COREBIZ_DISPOSABLE_DATABASE_URL
  COREBIZ_RESTORE_DATABASE_URL
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
  echo "[production-gate] BLOCKED: set COREBIZ_CONFIRM_DISPOSABLE_DB=YES only for disposable DBs" >&2
  exit 1
fi

if [[ -n "${DATABASE_URL:-}" && "${DATABASE_URL}" == "${COREBIZ_DISPOSABLE_DATABASE_URL}" ]]; then
  echo "[production-gate] BLOCKED: disposable DB must differ from DATABASE_URL" >&2
  exit 1
fi

if [[ -n "${DATABASE_URL:-}" && "${DATABASE_URL}" == "${COREBIZ_RESTORE_DATABASE_URL}" ]]; then
  echo "[production-gate] BLOCKED: restore DB must differ from DATABASE_URL" >&2
  exit 1
fi

if [[ "${COREBIZ_DISPOSABLE_DATABASE_URL}" == "${COREBIZ_RESTORE_DATABASE_URL}" ]]; then
  echo "[production-gate] BLOCKED: replay DB and restore DB must be different" >&2
  exit 1
fi

for binary in psql pg_dump pg_restore node pnpm sha256sum; do
  if ! command -v "$binary" >/dev/null 2>&1; then
    echo "[production-gate] BLOCKED: $binary is required" >&2
    exit 1
  fi
done

EVIDENCE_DIR="${COREBIZ_RELEASE_EVIDENCE_DIR:-./artifacts/release-gate}"
mkdir -p "$EVIDENCE_DIR"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
MANIFEST="$EVIDENCE_DIR/release-gate-$RUN_ID.json"
BACKUP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$BACKUP_DIR"
}
trap cleanup EXIT

PASS_STEPS=()

pass_step() {
  PASS_STEPS+=("$1")
}

write_manifest() {
  local status="$1"
  local joined=""
  local first=1
  for step in "${PASS_STEPS[@]}"; do
    if [[ "$first" -eq 0 ]]; then joined+=","; fi
    first=0
    joined+="\"$step\""
  done

  cat > "$MANIFEST" <<JSON
{
  "schemaVersion": 1,
  "runId": "$RUN_ID",
  "status": "$status",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "passedSteps": [$joined],
  "requiredEvidenceKinds": [
    "CORE:MIGRATIONS",
    "AUTH:RUNTIME_RLS",
    "API:INTEGRATION",
    "API:BUSINESS_JOURNEYS",
    "API:BROWSER_SMOKE",
    "CORE:RESTORE",
    "CORE:NOISY_NEIGHBOR",
    "FINANCE:RECONCILIATION",
    "ACCOUNTING:RECONCILIATION",
    "WMS:RECONCILIATION"
  ]
}
JSON
}

trap 'write_manifest "FAIL"; cleanup' ERR

echo "[production-gate] 1/12 source + disposable migration release check"
bash scripts/release-check.sh
pass_step "CORE:MIGRATIONS"

echo "[production-gate] 2/12 tenant RLS / runtime-role ownership gate"
psql "${COREBIZ_DISPOSABLE_DATABASE_URL}" -X -q -v ON_ERROR_STOP=1 \
  -f scripts/security_tenant_rls_gate.sql
pass_step "AUTH:RUNTIME_RLS"

echo "[production-gate] 3/12 SECURITY DEFINER grant gate"
psql "${COREBIZ_DISPOSABLE_DATABASE_URL}" -X -q -v ON_ERROR_STOP=1 \
  -f scripts/security_runtime_function_gate.sql
pass_step "CORE:SECURITY"

echo "[production-gate] 4/12 API business journey"
node scripts/smoke-user-journey.mjs
pass_step "API:INTEGRATION"

echo "[production-gate] 5/12 golden vertical business journeys"
node scripts/golden-business-journeys.mjs
pass_step "API:BUSINESS_JOURNEYS"

echo "[production-gate] 6/12 public commerce / booking diagnostics"
psql "${COREBIZ_DISPOSABLE_DATABASE_URL}" -X -q -v ON_ERROR_STOP=1 \
  -f scripts/public_commerce_booking_diagnostics.sql

echo "[production-gate] 7/12 Finance / bank / Accounting reconciliation"
psql "${COREBIZ_DISPOSABLE_DATABASE_URL}" -X -q -v ON_ERROR_STOP=1 \
  -f scripts/finance_bank_reconciliation_diagnostic.sql
pass_step "FINANCE:RECONCILIATION"
psql "${COREBIZ_DISPOSABLE_DATABASE_URL}" -X -q -v ON_ERROR_STOP=1 \
  -f scripts/accounting_period_audit_reconcile.sql
pass_step "ACCOUNTING:RECONCILIATION"

echo "[production-gate] 8/12 WMS / 3PL reconciliation"
psql "${COREBIZ_DISPOSABLE_DATABASE_URL}" -X -q -v ON_ERROR_STOP=1 \
  -f scripts/wms_3pl_reconcile.sql
psql "${COREBIZ_DISPOSABLE_DATABASE_URL}" -X -q -v ON_ERROR_STOP=1 \
  -f scripts/finance_3pl_reconcile.sql
pass_step "WMS:RECONCILIATION"

echo "[production-gate] 9/12 browser journey"
node scripts/smoke-browser-journey.mjs
pass_step "API:BROWSER_SMOKE"

echo "[production-gate] 10/12 backup -> restore drill"
DATABASE_URL="${COREBIZ_DISPOSABLE_DATABASE_URL}" \
  BACKUP_DIR="$BACKUP_DIR" \
  bash scripts/backup-postgres.sh

BACKUP_FILE="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'corebiz-*.dump' | sort | tail -n 1)"
if [[ -z "$BACKUP_FILE" || ! -f "$BACKUP_FILE" ]]; then
  echo "[production-gate] BLOCKED: backup file was not produced" >&2
  exit 1
fi

DATABASE_URL="${COREBIZ_RESTORE_DATABASE_URL}" \
  BACKUP_FILE="$BACKUP_FILE" \
  ALLOW_RESTORE=1 \
  bash scripts/restore-postgres.sh

RESTORED_MIGRATIONS="$(psql "${COREBIZ_RESTORE_DATABASE_URL}" -X -q -t -A -v ON_ERROR_STOP=1 \
  -c "SELECT count(*) FROM schema_migrations;")"
if [[ -z "$RESTORED_MIGRATIONS" || "$RESTORED_MIGRATIONS" -le 0 ]]; then
  echo "[production-gate] BLOCKED: restored DB has no schema_migrations" >&2
  exit 1
fi

psql "${COREBIZ_RESTORE_DATABASE_URL}" -X -q -v ON_ERROR_STOP=1 \
  -c "SELECT count(*) FROM tenant;" >/dev/null
pass_step "CORE:RESTORE"

echo "[production-gate] 11/12 noisy-neighbor / runtime pressure gate"
node scripts/noisy-neighbor-gate.mjs
pass_step "CORE:NOISY_NEIGHBOR"
pass_step "CORE:PERFORMANCE"

echo "[production-gate] 12/12 release-readiness structural diagnostics"
echo "[production-gate] NOTE: tenant-specific readiness diagnostics must be run with app.tenant_id set for each pilot tenant."

write_manifest "PASS"
trap - ERR

echo "[production-gate] PASS: disposable migration, runtime RLS, API/browser journeys, reconciliation, restore and noisy-neighbor gates completed."
echo "[production-gate] evidence manifest: $MANIFEST"
echo "[production-gate] This command does not deploy. Production rollout still requires immutable evidence recording and owner approval."
