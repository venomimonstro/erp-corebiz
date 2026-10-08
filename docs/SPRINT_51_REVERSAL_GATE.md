# Sprint 51 — posting and reversal verification

## Implemented
- Accounting posting idempotency compares stored operation fields to a replay request.
- Dedicated POST /accounting/entries/reverse guarded with accounting.reverse.
- Reversal requires original entry, open period, effective approved rule, reversed debit/credit, matching amount and currency.
- One reversal per original entry is enforced by unique (tenant_id,reversal_of_id).

## Release blockers
- No automatic statutory tax calculations or payroll posting.
- API inputs need validation DTOs and strict UUID/date validation.
- PostgreSQL tests required: concurrent duplicate posting/reversal, replay with different payload, period close races.
- Verify the approved policy and posting rule flow with a qualified accountant.
- Run pnpm typecheck, pnpm build and migration replay manually (no CI / GitHub Actions).
- Reversal idempotency should additionally verify every request dimension on replay before enabling financial production.

This is an engineering milestone, not accounting certification.
