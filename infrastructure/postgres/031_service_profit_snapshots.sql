BEGIN;

ALTER TABLE service_booking_resource
  ADD COLUMN cost_per_hour_minor_snapshot bigint NOT NULL DEFAULT 0
  CHECK (cost_per_hour_minor_snapshot >= 0);

ALTER TABLE service_booking_material
  ADD COLUMN unit_cost_minor_snapshot bigint NOT NULL DEFAULT 0
  CHECK (unit_cost_minor_snapshot >= 0);

UPDATE service_booking_resource br
SET cost_per_hour_minor_snapshot = r.cost_per_hour_minor
FROM service_resource r
WHERE r.tenant_id = br.tenant_id
  AND r.id = br.resource_id
  AND br.cost_per_hour_minor_snapshot = 0;

UPDATE service_booking_material m
SET unit_cost_minor_snapshot = s.cost_price_minor
FROM sku s
WHERE s.tenant_id = m.tenant_id
  AND s.id = m.sku_id
  AND m.unit_cost_minor_snapshot = 0;

COMMIT;
