#!/usr/bin/env bash
set -euo pipefail

echo "[release] typecheck"
pnpm typecheck

echo "[release] tests"
pnpm test

echo "[release] build"
pnpm build

if [[ -n "${DATABASE_URL:-}" ]]; then
  echo "[release] migrations"
  pnpm db:migrate
else
  echo "[release] DATABASE_URL not set; migration check skipped"
fi

echo "[release] complete"
