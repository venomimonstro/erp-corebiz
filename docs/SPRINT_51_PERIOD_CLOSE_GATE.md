# Sprint 51 — Accounting period close and audit

Implemented: migration 087 immutable period transition history; tenant-safe staged lock service and `POST /accounting/periods/lock`; `GET /accounting/periods/history?periodId=...`.

Allowed staged operations through the service: OPEN → SOFT_LOCKED → HARD_LOCKED. A reason of at least eight characters and `accounting.period.close` are required. HARD_LOCKED cannot be reopened through the ordinary period update guard.

## Production gate

- Replay migrations through 087 in PostgreSQL, including existing-data upgrade.
- Confirm journal posting cannot race past closing-period row locks.
- Verify tenant isolation and authorization of lock and history APIs.
- Verify duplicate stage close returns an idempotent response and does not duplicate history.
- Verify reversal into closed periods is rejected.
- Verify audit rows are immutable and state transitions roll back with transaction failures.
- Check direct database writes to `accounting_period.state` cannot circumvent operational audit policy; harden before regulatory use.
- Run local TypeScript typecheck, build, tests and backup/restore drill.

This is not Russian statutory accounting sign-off. No CI or GitHub Actions were created.
