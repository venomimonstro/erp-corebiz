# Sprint 51 — Accounting API integration status

The NestJS accounting module now exposes:
- GET /accounting/accounts
- POST /accounting/accounts (accounting.policy.manage)
- GET /accounting/periods?legalEntityId=UUID
- POST /accounting/periods (accounting.period.close)
- GET /accounting/entries?legalEntityId=UUID
- POST /accounting/entries (accounting.post)

All handlers read tenant identity from authenticated session context and use the database tenant transaction helper. Ordinary posting cannot specify a reversal reference. Posting resolves one approved rule, locks the OPEN period and records a single balanced debit/credit pair.

Known remaining work:
- Versioned policy and rule authoring, review and approval API/UI.
- Dedicated accounting.reverse permission and reversal service.
- Bank and source-event reconciliation, automatic postings, VAT, tax rules, period-close approval and reporting.
- Concurrent posting-key/idempotency regression, input schema validation, proper unique-constraint mapping.
- Confirm migration 081–086 against PostgreSQL and check build/tests before deploying.

Do not use this accounting module for regulated reports or tax filings before accountant verification. No GitHub Actions/CI are configured by this sprint.
