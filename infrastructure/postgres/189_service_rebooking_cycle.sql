BEGIN;

ALTER TABLE service_catalog_item
  ADD COLUMN IF NOT EXISTS rebook_after_days integer,
  ADD COLUMN IF NOT EXISTS rebook_grace_days integer NOT NULL DEFAULT 3;

ALTER TABLE service_catalog_item
  DROP CONSTRAINT IF EXISTS service_catalog_item_rebook_after_days_ck,
  DROP CONSTRAINT IF EXISTS service_catalog_item_rebook_grace_days_ck;

ALTER TABLE service_catalog_item
  ADD CONSTRAINT service_catalog_item_rebook_after_days_ck
    CHECK (
      rebook_after_days IS NULL OR
      rebook_after_days BETWEEN 1 AND 3650
    ),
  ADD CONSTRAINT service_catalog_item_rebook_grace_days_ck
    CHECK (rebook_grace_days BETWEEN 0 AND 365);

CREATE INDEX IF NOT EXISTS service_booking_rebook_lookup_idx
  ON service_booking(
    tenant_id,party_id,service_id,status,completed_at,starts_at
  )
  WHERE party_id IS NOT NULL;

COMMIT;
