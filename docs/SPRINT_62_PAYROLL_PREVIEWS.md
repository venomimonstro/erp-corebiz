# Sprint 62 — Payroll preparation without statutory calculations

Direct-to-main changes:
- 115_payroll_export_preview.sql: one immutable preview preparation receipt per approved accrual batch and export kind, isolated by tenant.
- PayrollService.batchSummary reports gross amounts, manually provided deductions and the difference in minor units.
- PayrollService.prepareExport requires an approved batch; repeated preparation of the same kind returns the previous receipt.
- GET /accounting/payroll/batches/:batchId/summary (accounting.read)
- POST /accounting/payroll/exports/prepare (accounting.period.close)

**Important:** PREPARED is only an audit marker, not a downloadable file and not a money movement. The net_preview_minor column does not calculate Russian NDFL, insurance contributions, alimony or withholding: it subtracts only stored manual deduction_minor values. No financial obligation, accounting posting, payslip, tax filing or employee bank transfer is created.

Acceptance gates:
1. Manual migration replay through 115 and TypeScript build.
2. Cross-tenant isolation and role checks.
3. Concurrent duplicate preview requests produce one receipt.
4. Draft batch preview rejected.
5. Approval racing with line edits cannot change approved totals.
6. Security review before introducing employee personal data.
7. Accountant/payroll-specialist review before any statutory calculations.

No CI or GitHub Actions have been created.
