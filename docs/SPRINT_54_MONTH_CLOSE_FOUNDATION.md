# Sprint 53–54 — VAT date integrity and month-close checklist

## Changes
- Migration 103 requires a VAT source document date and its register event date to lie inside the same OPEN VAT period. This is a deliberately restrictive interim model, not a complete treatment of late deductions and amendments under Russian law.
- Migration 104 creates tenant-scoped month-close checklist categories: JOURNAL, BANK, RECEIVABLES, PAYABLES, INVENTORY, VAT and PAYROLL.
- Migration 105 requires a tenant-valid reviewer and timestamp for DONE checks and forbids checklist updates once the linked accounting period is HARD_LOCKED.

## Remaining work / gates
- VAT corrections, deferred VAT deductions, adjustments and late registration must be modeled before regulatory use.
- Checklist must be integrated with the accounting API and financial reconciliation, and month close should be blocked by unresolved checks through an audited workflow.
- New tables have database row-level tenant isolation; API authorization still needs implementation.
- Run PostgreSQL migration replay through 105, local typecheck/build and concurrency tests.
- Perform accountant-led validation against statutory reference cases.

Source code was committed directly to main with no GitHub Actions/CI. This is not statutory accounting readiness.
