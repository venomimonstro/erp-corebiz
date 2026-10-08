# Sprint 52 — Audited bank matching corrections

Implemented on main:
- Migration 093: immutable correction journal `finance_bank_match_audit` and an audited matching guard.
- `POST /finance/bank-statements/unmatch` (finance.write): retract a matched payment association on an IMPORTED statement only, with a reason of at least 12 characters and acting tenant membership. PostgreSQL records the original payment link and actor atomically.
- `GET /finance/bank-statements/lines/:lineId/audit` (finance.read): inspect correction history for a tenant-scoped bank line.
- Migration 094: a bank statement must contain at least one line, and all its lines must have a payment match, before being marked RECONCILED.

No bank statement operation in this sprint creates or reverses a payment.

## Acceptance checklist
1. Replay migrations through 094 on fresh and sanitized populated PostgreSQL.
2. Match, unmatch with a reason, and match again on the same IMPORTED statement; verify immutable audit.
3. Try unmatch with no reason, cross-tenant actor and RECONCILED statement: reject.
4. Try finalizing empty and partly unmatched statements: reject.
5. Run two match and unmatch requests concurrently; verify one payment-to-line invariant and no lost audit.
6. Verify payment reversal is blocked for currently matched payments.
7. Run local backend typecheck, build and integration tests, then perform backup/restore.
8. Check session-context safety: DB service credentials must remain private. The session actor/reason are application controls, not protection from privileged database operators.

Next: validated parsers for Russian bank formats and 1C exchange, cash book, bank balance matching; thereafter controlled VAT data model and tax register work. No CI or GitHub Actions introduced. Production acceptance remains open.
