# Sprint 51 — concurrency and trial-balance hardening

Implemented:
- Serialize concurrent journal posting requests per tenant/posting key with transaction advisory locks.
- Serialize reversal attempts per tenant/original entry.
- Expose GET /accounting/trial-balance?legalEntityId=...&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD, guarded by accounting.read.
- Report debit, credit and net debit per account using immutable journal entries. Amounts are returned as minor-unit strings.

Required local acceptance tests before production:
1. Parallel identical posting keys create exactly one journal entry; changed payload yields conflict.
2. Concurrent reversal requests for a single entry create no more than one reversal.
3. Period lock racing with posting never admits a posting after period closure.
4. Trial balance debit-turnover sum equals credit-turnover sum for one legal entity and date range.
5. No cross-tenant account, entry or legal-entity access.
6. Run all migrations (including 081–086), typecheck, build and integration tests on a PostgreSQL-backed environment.
7. Compare reference journals with an accountant and verify opening balances, statutory chart mappings and any FX effects.

Important: trial-balance output is a diagnostic turnover report, not a complete statutory balance sheet. No CI or GitHub Actions are introduced. This sprint's production gate remains open.
