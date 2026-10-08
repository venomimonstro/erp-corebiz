# Sprint 52 — Bank statement staging

Migration `089_finance_bank_statement_staging.sql` introduces tenant-scoped statement headers and individual statement lines. Imported data is **staging**, not an automatic accounting or bank cash posting.

Highlights: deduplication of external statement and line identifiers, currency/cash-account match, date range validation, and matching a statement line to an existing posted payment only when amount, direction, currency and cash account agree.

## Remaining engineering

- Authenticated statement import API, upload parsing and file validation.
- Transactional matching/unmatching flow with full audit and concurrent match protection.
- Prevention of matching the same payment to multiple bank statement lines.
- Refund/reversal semantics, bank-specific formats, opening/closing bank balance reconciliation.
- Manual PostgreSQL migration replay and integration tests.

No financial source of truth is mutated by the staging import tables. Never auto-reconcile or auto-post from unverified bank files.
