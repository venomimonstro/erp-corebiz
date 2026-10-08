# Sprint 51 — Posting rules and accounting periods

## Source changes
- 084: require an approved posting rule and approved policy covering the journal business date and legal entity.
- 085: prevent overlapping accounting periods within the same tenant/legal entity; lock period configuration during concurrent writes.
- HARD_LOCKED periods cannot reopen via a direct period UPDATE.

## Important limitations
- Production rollout remains blocked until PostgreSQL migrations are replayed and validated.
- Approval authority must be enforced in the NestJS application service; database status alone does not establish authorization.
- Reverse entries require a separately approved reversal rule matching swapped debit and credit accounts.
- This release does not calculate statutory taxes and must not be used as a Russian tax reporting product.
- Prior journal entries are not rewritten by 084.

## Acceptance tests
1. New tenant cannot insert a journal entry without an approved effective-dated rule.
2. Rule with different account, source type, legal entity or expired validity is rejected.
3. No overlapping accounting periods, including parallel inserts.
4. Journal posting racing with period lock is serialized by period row lock.
5. HARD_LOCKED period rejects reopening.
6. Credit/debit turnover equality remains true.
7. Two tenants cannot read/write each other's accounting entries.
8. Reversal uses correct approved reversal rule.
9. Run migrations on empty and sanitized populated PostgreSQL; run typecheck/build/tests.
