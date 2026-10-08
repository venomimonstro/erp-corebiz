# Sprint 65 — Operator booking details and live availability

Committed directly to main, without CI or GitHub Actions.

## Delivered
- Authenticated, tenant-bound GET /api/v1/service/bookings/:id, restricted by service.read.
- Calendar-side details panel retrieves appointment on demand and shows service, customer, time, assigned resources, status and service price. Price is **not** recorded cash received.
- Booking creation form can request open time slots from existing GET /api/v1/service/availability using a chosen service, resource and date.
- On changing service/resource/date, previously returned slots and chosen time are cleared.
- Final booking creation still uses BookingService.createBooking's locked-resource availability validation: a suggested slot is not a reservation.

## Acceptance blockers
- Production PostgreSQL migration replay and build remain unverified.
- Verify public booking requires authenticated permissions only for staff: create a separate carefully rate-limited public API for client self-service.
- Test concurrent double-booking, over-capacity resources, schedule gaps, daylight-saving changes, network failures and accessibility.
- Add verified payment ledger and material consumption to appointment details before marketing as a financial close-out screen.
- Replace manually entered date-time with a fully slot-led wizard after timezone policy is decided.
