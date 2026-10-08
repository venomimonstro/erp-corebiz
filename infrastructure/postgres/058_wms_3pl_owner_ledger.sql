BEGIN;

CREATE TABLE inventory_owner_movement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES inventory_owner(id) ON DELETE RESTRICT,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
  movement_type text NOT NULL
    CHECK (movement_type IN (
      'BOOTSTRAP','RECEIPT','RESERVE','RELEASE','SHIPMENT',
      'RETURN','ADJUSTMENT','TRANSFER_IN','TRANSFER_OUT'
    )),
  physical_delta_milli bigint NOT NULL DEFAULT 0,
  reserved_delta_milli bigint NOT NULL DEFAULT 0,
  source_type text NOT NULL,
  source_id uuid,
  source_line_id uuid,
  idempotency_key text NOT NULL,
  actor_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (physical_delta_milli <> 0 OR reserved_delta_milli <> 0),
  UNIQUE (tenant_id,idempotency_key)
);

CREATE INDEX inventory_owner_movement_lookup_idx
  ON inventory_owner_movement(
    tenant_id,warehouse_id,owner_id,sku_id,created_at,id
  );

CREATE TABLE warehouse_location_owner_movement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES inventory_owner(id) ON DELETE RESTRICT,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
  movement_type text NOT NULL
    CHECK (movement_type IN (
      'BOOTSTRAP','PUTAWAY','MOVE','PICK','SHIP',
      'RETURN','ADJUSTMENT','TRANSFER_IN','TRANSFER_OUT'
    )),
  from_location_id uuid REFERENCES warehouse_location(id) ON DELETE RESTRICT,
  to_location_id uuid REFERENCES warehouse_location(id) ON DELETE RESTRICT,
  quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
  source_type text NOT NULL,
  source_id uuid,
  source_line_id uuid,
  idempotency_key text NOT NULL,
  actor_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    from_location_id IS NOT NULL OR
    to_location_id IS NOT NULL
  ),
  UNIQUE (tenant_id,idempotency_key)
);

CREATE INDEX warehouse_location_owner_movement_lookup_idx
  ON warehouse_location_owner_movement(
    tenant_id,warehouse_id,owner_id,sku_id,created_at,id
  );

ALTER TABLE inventory_owner_movement ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_location_owner_movement ENABLE ROW LEVEL SECURITY;

CREATE POLICY inventory_owner_movement_isolation
  ON inventory_owner_movement
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE POLICY warehouse_location_owner_movement_isolation
  ON warehouse_location_owner_movement
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

COMMIT;
