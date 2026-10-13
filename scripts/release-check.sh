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

echo "[release] source stability preflight"
pnpm stability:check

echo "[release] standalone migration gate regression tests"
node --test scripts/migration-preflight.test.mjs scripts/env-boundary.test.mjs scripts/security-runtime-grants.test.mjs

echo "[release] validate owner playbooks and simulate every failure path"
node --test scripts/owner-industry-journeys.test.mjs scripts/multirole-source-contract.test.mjs scripts/dance-owner-contract.test.mjs scripts/dance-shift-pattern.test.mjs

echo "[release] validate operator scripts and 99.9% SLO evaluator"
node --check scripts/multirole-api-e2e.mjs
node --check scripts/dance-two-branch-owner-e2e.mjs
node --check scripts/owner-17-vertical-api-e2e.mjs
node --check scripts/service-desk-browser-journey.mjs
node --check scripts/owner-business-setup-e2e.mjs
node --check scripts/owner-first-day-journey.mjs
node --check scripts/simulate-100-users.mjs
node --check scripts/golden-business-journeys.mjs
node --check scripts/slo-availability.mjs
node --test scripts/slo-availability.test.mjs

echo "[release] static typecheck"
pnpm typecheck

echo "[release] existing tests"
pnpm test

echo "[release] build"
pnpm build

echo "[release] migration replay on explicitly confirmed disposable DB"
DATABASE_URL="${COREBIZ_DISPOSABLE_DATABASE_URL}" pnpm db:migrate

echo "[release] verify explicit runtime SQL-function EXECUTE grants"
if ! command -v psql >/dev/null 2>&1; then
  echo "[release] BLOCKED: psql is required for runtime grant gate" >&2
  exit 1
fi
psql "${COREBIZ_DISPOSABLE_DATABASE_URL}" \
  -X -q -v ON_ERROR_STOP=1 \
  -f scripts/security_runtime_function_gate.sql
echo "[release] verified OWNER-role authority and escalation protection"
psql "${COREBIZ_DISPOSABLE_DATABASE_URL}" \
  -X -q -v ON_ERROR_STOP=1 \
  -f scripts/security_rbac_owner_gate.sql

echo "[release] automated source checks finished"
echo "[release] NOT PRODUCTION APPROVED: still require DB role/RLS, load, security, tenant, business workflow and backup/restore validation"
