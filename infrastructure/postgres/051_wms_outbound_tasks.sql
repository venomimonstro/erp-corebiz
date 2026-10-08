BEGIN;

ALTER TABLE warehouse_task
  DROP CONSTRAINT IF EXISTS warehouse_task_task_type_check;

ALTER TABLE warehouse_task
  ADD CONSTRAINT warehouse_task_task_type_check
  CHECK (task_type IN (
    'PUTAWAY','MOVE','PICK','PACK','SHIP','REPLENISH','COUNT'
  ));

CREATE TABLE wms_pick_allocation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  sales_order_id uuid NOT NULL REFERENCES sales_order(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES inventory_reservation(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
  source_location_id uuid NOT NULL REFERENCES warehouse_location(id) ON DELETE RESTRICT,
  outbound_location_id uuid NOT NULL REFERENCES warehouse_location(id) ON DELETE RESTRICT,
  quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
  status text NOT NULL DEFAULT 'PLANNED'
    CHECK (status IN ('PLANNED','PICKED','PACKED','SHIPPED','RELEASED')),
  pick_task_id uuid REFERENCES warehouse_task(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  picked_at timestamptz,
  packed_at timestamptz,
  shipped_at timestamptz,
  UNIQUE (reservation_id,source_location_id)
);

CREATE INDEX wms_pick_allocation_order_idx
  ON wms_pick_allocation(
    tenant_id,sales_order_id,warehouse_id,status
  );

CREATE INDEX wms_pick_allocation_location_idx
  ON wms_pick_allocation(
    tenant_id,warehouse_id,source_location_id,status
  )
  WHERE status IN ('PLANNED','PICKED','PACKED');

ALTER TABLE wms_pick_allocation ENABLE ROW LEVEL SECURITY;

CREATE POLICY wms_pick_allocation_isolation
  ON wms_pick_allocation
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

COMMIT;
