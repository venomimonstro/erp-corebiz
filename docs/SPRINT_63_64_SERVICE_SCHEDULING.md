# Sprint 63–64: Service scheduling integrity and usability

Date: 2026-10-08. Source committed directly to main, without CI or GitHub Actions.

## Changes
- BookingService.setStatus now uses an atomic transition predicate. Only CONFIRMED/DRAFT → ARRIVED/CANCELLED/NO_SHOW, ARRIVED → IN_SERVICE/CANCELLED/NO_SHOW, IN_SERVICE → COMPLETED/CANCELLED. Terminal statuses are not reopened.
- Migration 116 applies the same transition invariant to PostgreSQL writers outside the API.
- Service booking calendar supports previous/next seven-day navigation, current period reset, resource/staff filter, and an empty state.
- Date-time prompts now use local time instead of UTC conversion that previously could shift the selected time.
- Existing booking creation/reschedule already locks selected service resources and checks capacity, schedule and blocks. That logic still needs concurrent integration tests and DST/timezone tests.

## Acceptance blockers
1. Apply migrations through 116 on a disposable DB and populated staging.
2. Run local frontend/backend typecheck, build and booking tests.
3. Integration test two concurrent customers requesting the last available resource slot; exactly one must succeed.
4. Attempt invalid status transitions via API and raw SQL; both must be rejected.
5. Test single booking with multiple resources and a reschedule race.
6. Test worker/webhook retries and duplicate idempotency keys.
7. Verify Europe/Moscow and Europe/Berlin time zones during DST changes and overnight resource schedules.
8. Record cash collected separately from value of completed services. A completed booking alone is not payment.
9. UX follow-up: drag-and-drop timetable per employee/room, proper modal forms instead of prompt, side panel appointment card, accessible keyboard interactions.
10. Public booking follow-up: customer chooses a service/resource/slot, gets reservation hold, confirms details under anti-abuse limits.

Not a production release claim.
