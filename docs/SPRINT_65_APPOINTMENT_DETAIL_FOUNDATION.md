# Sprint 65: appointment detail foundation

Added tenant-scoped `BookingService.bookingDetails` and authenticated `GET /api/v1/service/bookings/:id`, guarded by `service.read`. The response contains visit status, timing, notes, service, assigned resources, customer display name, and booked service price. It is not proof of payment.

Next acceptance: validate permission and tenant boundaries with integration tests; add the booking side panel to the client calendar; join customer history and materials using separate authorized service APIs; then implement public slot selection, anti-abuse and concurrency checks.

No production migration or runtime test was executed. No CI or GitHub Actions.
