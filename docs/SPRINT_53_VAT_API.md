# Sprint 53 — VAT API and registration acceptance

Implemented: `097` direction check, `098` one register entry per document, and VAT API endpoints under `/accounting/vat`.

- `GET /documents?legalEntityId=` (accounting.read)
- `POST /documents` (accounting.policy.manage) — create draft with explicitly entered amounts
- `POST /documents/:documentId/approve` (accounting.policy.manage)
- `POST /register` (accounting.post) — register previously approved document
- `GET /register?legalEntityId=` (accounting.read)

All operations use tenant-bound database transactions. Register entries are immutable. The system does **not** calculate VAT from a rate code or automatically file returns. UPD registration direction remains a domain decision requiring regulatory review.

Release gates: PostgreSQL replay through 098, TypeScript build and unit/integration tests, cross-tenant and duplicate registration tests, accurate rate/date interpretation, support of correction documents, legal-entity period closure and accountant sign-off. No CI or GitHub Actions added.
