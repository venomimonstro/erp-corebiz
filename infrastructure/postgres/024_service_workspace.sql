BEGIN;

ALTER TABLE service_booking
  ADD COLUMN sales_order_id uuid REFERENCES sales_order(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX service_booking_sales_order_uq
  ON service_booking(tenant_id, sales_order_id)
  WHERE sales_order_id IS NOT NULL;

CREATE TABLE service_booking_material (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES service_booking(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE RESTRICT,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
  planned_quantity_milli bigint NOT NULL CHECK (planned_quantity_milli > 0),
  consumed_quantity_milli bigint NOT NULL DEFAULT 0 CHECK (consumed_quantity_milli >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (consumed_quantity_milli <= planned_quantity_milli)
);

CREATE INDEX service_booking_material_booking_idx
  ON service_booking_material(tenant_id, booking_id);

ALTER TABLE service_booking_material ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_booking_material_isolation
  ON service_booking_material
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
