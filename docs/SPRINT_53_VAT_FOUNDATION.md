# Sprint 53 — VAT document and register foundation

Implemented in main: migrations `095_accounting_vat_foundation.sql` and `096_accounting_vat_document_lifecycle.sql`.

The system now stores tenant-isolated VAT evidence snapshots by legal entity, linked counterparty and operational source. An immutable VAT register can reference only an APPROVED document in the same tenant/legal entity with matching VAT amount. Registered VAT documents cannot be silently cancelled; correcting documents must be posted separately.

**Not implemented:** automatic VAT calculation, legally validated rate/rule versions, tax invoice numbering regulations, tax-period ledger, books of sales/purchases, statutory exports, and correction/credit workflows. This is not a certified Russian tax implementation.

Manual acceptance: full PostgreSQL migration replay through 096; cross-tenant tests; DRAFT→APPROVED permissions; prohibited snapshot edits and registered cancellation; concurrent register inserts and unique keys; statutory validation by a qualified Russian accountant; local build and tests. No CI or Actions are configured.
