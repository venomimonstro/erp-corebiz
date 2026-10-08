# Sprint 64 continued — Service appointment operator UX

Commits delivered directly to main (no CI or Actions):
- Inline appointment creation with service, resource and local date/time fields. The API remains the source of truth for availability/locking.
- Inline appointment rescheduling instead of a prompt; server version check still handles concurrent edits.
- Confirm dialog before cancellation.
- Server-side 31-day ceiling and invalid-date validation on calendar listing.
- Reject unknown status values and malformed optimistic-concurrency versions before attempting DB writes.

## Not complete / next slices
1. Replace the day-card list with accessible staff×time scheduler (mobile and desktop), use drag/drop only with keyboard alternative and rollback on conflict.
2. Fetch available slots for the selected service/resource before save, and show actionable conflicts.
3. Appointment side panel: customer details, visit history, notes, supplies, amount invoiced, deposits received and actual payments.
4. Public customer self-service booking with one-time confirmation, consent and anti-abuse controls.
5. Manual migration replay through 116, compile and browser E2E, concurrent last-slot tests, time-zone/DST and weekend/overnight schedule tests.
6. Never call service booking value “cash received” unless reconciled with payment ledger.

Production acceptance and automated test outcomes are **not confirmed**.
