# Sprint 65–66: Public self-service appointment slots (2026-10-08)

Implemented directly in main, without CI or GitHub Actions:

- `GET /api/v1/site-forms/availability/:publicKey?from=...&to=...` resolves a currently enabled BOOKING form using existing database resolver. Exposes only matching configured resource slots, at most 100 rows.
- Availability access is rate-limited per form; requests restricted to 24-hour windows and dates no further than 90 days ahead. Slots in the past are excluded; bookings for the rest of the current day remain possible.
- Public form selects day, loads available resource/time options, then submits both `startsAt` and `resourceId`.
- Submission verifies the chosen resource is one of the form's configured resource IDs; it is not possible to book another resource by changing client input. Legacy single-resource forms can continue omitting `resourceId`.
- Final booking creation still uses resource row locks and capacity validation; fetched free slots do not reserve capacity.
- Dashboard wording separates **service value** from verified cash received.

## Critical acceptance
- Staging migration replay, NestJS and Next.js typecheck/build, public form browser test and cross-tenant tests have **not** been executed.
- Concurrency test: two simultaneous public bookings on last slot; exactly one succeeds.
- Set up BOOKING form with an explicitly configured resource; empty resource configuration yields no public slots.
- Verify time zones, DST, at-limit request throttling, broken stale slots, inactive form keys and invalid resource IDs.
- Migration 117 adds PROCESSING state; submission is atomically claimed, so two requests with the same idempotency key cannot concurrently create two bookings. A FAILED submission is intentionally not auto-retried: manual reconciliation is needed because customer creation and booking creation are not one transaction. Add a recovery workflow before production.
- Public data abuse: use per-IP limits in addition to per-form throttling, reject unbounded or malicious payloads, and monitor form spam.
- For multi-resource sessions and group capacity, design a separate slot/allocation model; current public selection is single resource only.
- Sprint 66 payment reconciliation and fiscal integration are **not** implemented by these changes.

No production acceptance is claimed.
