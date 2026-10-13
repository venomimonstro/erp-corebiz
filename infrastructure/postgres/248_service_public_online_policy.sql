BEGIN;
-- YCLIENTS-inspired public visibility is independent of internal scheduling.
-- Existing staff remain bookable unless the owner explicitly opts out.
ALTER TABLE service_resource
  ADD COLUMN IF NOT EXISTS online_booking_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS online_min_lead_minutes integer NOT NULL DEFAULT 0
    CHECK(online_min_lead_minutes BETWEEN 0 AND 10080);
CREATE INDEX IF NOT EXISTS service_resource_public_bookable_idx
 ON service_resource(tenant_id,type,status,online_booking_enabled);
COMMIT;
