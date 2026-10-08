# Sprint 50 — Finance / 3PL reconciliation

## Added
- Migration 079: cash-account and obligation dimensions are verified for every payment.
- Migration 080: payment and financial-obligation Party must belong to the same tenant.
- Read-only SQL diagnostic: `scripts/finance_3pl_reconcile.sql`.

All migrations fail closed when pre-existing financial data violates the proposed invariants. They do not attempt to change prior postings.

## Required validation
1. Replay migrations on a fresh PostgreSQL instance.
2. Exercise previous payment workflows (customer payment, supplier payment, refund, reversal and 3PL invoice payment).
3. Attempt a payment with a cash account from another tenant or a different currency: reject.
4. Attempt a payment or obligation with another tenant's Party: reject.
5. Confirm duplicate payment idempotency keys never generate duplicate receipts.
6. Reconcile `finance_invoice`, `financial_obligation` and `payment` for multiple tenants.
7. Investigate diagnostic exceptions before changing settlement logic. The read-only diagnostic assumes standard incoming PAYMENT and outgoing REFUND accounting; special allocations require manual interpretation.
8. Execute local `pnpm typecheck`, `pnpm build`, `pnpm test`, and PostgreSQL integration tests before deployment.

Status: source changes committed to main; production verification incomplete. This work does not implement statutory Russian accounting.
