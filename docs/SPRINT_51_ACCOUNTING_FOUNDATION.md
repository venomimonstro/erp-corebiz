# Sprint 51 — Accounting RU foundation

## Implemented in main
- 081: tenant-scoped chart of accounts, legal-entity periods, immutable paired debit/credit journal.
- Reversal linked to original, with swapped debit/credit and identical amount/currency.
- Posting checks enforce OPEN accounting period and active debit/credit accounts.
- Role permissions for FINANCE/ADMIN.
- Read-only trial-balance query at `scripts/accounting_trial_balance.sql`.

## Deliberate limitations
- The journal currently models one debit and one credit account per entry, not compound postings.
- No auto-posting from Sales, Procurement, Inventory or Finance.
- No official Russian chart of accounts seeded yet; no VAT or tax calculations.
- The trial-balance query is an internal diagnostic, not a regulatory report.
- The SQL migration and release-gate tests have not been run against PostgreSQL.

## Next
1. Build audited, effective-dated, deterministic posting rules, initially in DRAFT state.
2. Introduce versioned accounting policy and legal-entity/period reconciliation.
3. Implement posting service with source-event idempotency and explicit finance permissions.
4. Add a formal close/reopen approval flow with audit and regression tests.
5. Verify against accountant-approved reference periods prior to any statutory launch.

## Acceptance criteria
- Migration run from 001 on clean database.
- Two-tenant access and cross-tenant write isolation.
- Concurrent journal insert with same posting_key resolves to one posting.
- Reversal cannot target another tenant, legal entity, amount or currency.
- Ledger UPDATE/DELETE rejected.
- Period close races with journal insert cannot post into locked period.
- Multi-company separation, trial-balance debits equal credits.
- Full local build/typecheck/test plus backup/restore.
