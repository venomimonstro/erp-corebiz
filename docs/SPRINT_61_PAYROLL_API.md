# Sprint 61 — Payroll API and stabilization follow-up

Implemented directly on main, without CI/GitHub Actions:

- `113_payroll_line_guard_correction.sql` fixes DELETE trigger handling by checking OLD values, and guards write operations against approved batches.
- `114_payroll_approval_integrity_fix.sql` validates that payroll approval has a tenant-valid actor and at least one accrual line.
- Added tenant-scoped PayrollService and protected API endpoints:
  - `GET /accounting/payroll/batches?legalEntityId=`
  - `POST /accounting/payroll/batches`
  - `POST /accounting/payroll/lines`
  - `POST /accounting/payroll/batches/:batchId/approve`

## Deliberate limits
- This is a payroll **accrual staging** product, not automated Russian payroll accounting.
- No NDFL, statutory contribution, employment contract or tax report computation is implemented.
- Employee references are external identifiers, not a secured personal-record subsystem.
- There is no automatic transfer to payment/financial obligation/journal entries.
- Approval needs accountant/payroll review before use for pay statements.

## Release acceptance
- Run migrations through 114 on empty and existing PostgreSQL databases.
- Verify batch approval, no empty approval, and edits/deletions on approved batches are rejected.
- Verify no cross-tenant legal entity, employee batch, actor, or line writes.
- Test multiple workers updating the same batch; ensure locking prevents post-approval changes.
- Run local typecheck, build, and API integration tests.
- Do not mark release checks PASS without actual evidence.

Production acceptance remains open.
