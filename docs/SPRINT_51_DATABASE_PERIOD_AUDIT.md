# Sprint 51 — Database-owned period close audit

## Implementation
- Migration `088_accounting_period_database_audit.sql` installs an AFTER UPDATE trigger for accounting period state changes.
- Transition actor and reason are passed transaction-locally by AccountingService via `set_config(..., true)`.
- Trigger validates actor membership in the same tenant, reason length and allowed sequential transitions.
- Immutable transition record is inserted in the same transaction as the period update. A failure rolls back both.
- A read-only health query is provided at `scripts/accounting_period_audit_reconcile.sql`.

## Explicit limits
- The database connection used by the service must not be exposed to untrusted clients; a privileged SQL user able to set arbitrary session parameters is outside this application-level authority model.
- All existing period state changes before migration 088 must be inspected with the reconciliation script; no audit history is fabricated.
- A dedicated audited reopen workflow has not been implemented.

## Manual acceptance (no CI)
1. Replay migrations through 088 on a fresh PostgreSQL database.
2. Verify period OPEN to SOFT_LOCKED, and SOFT_LOCKED to HARD_LOCKED each produce exactly one audit row.
3. Attempt a direct UPDATE without actor/reason: reject, no state change.
4. Attempt to impersonate an actor of another tenant: reject.
5. Attempt OPEN to HARD_LOCKED or HARD_LOCKED to OPEN: reject.
6. Confirm concurrent closure/posting cannot book into a locked period.
7. Inspect `scripts/accounting_period_audit_reconcile.sql` output and investigate historical mismatches.
8. Run the local API typecheck/build/test and full migration replay before rollout.

**Status:** source changes are committed to main; database execution is not yet verified.
