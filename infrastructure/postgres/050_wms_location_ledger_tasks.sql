BEGIN;

ALTER TABLE warehouse_zone
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

ALTER TABLE warehouse_location
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

CREATE TABLE warehouse_location_balance (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES warehouse_location(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE CASCADE,
  physical_milli bigint NOT NULL DEFAULT 0 CHECK (physical_milli >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,warehouse_id,location_id,sku_id)
);

CREATE INDEX warehouse_location_balance_sku_idx
  ON warehouse_location_balance(tenant_id,warehouse_id,sku_id,physical_milli)
  WHERE physical_milli > 0;

CREATE TABLE wms_location_movement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
  movement_type text NOT NULL
    CHECK (movement_type IN (
      'BOOTSTRAP','RECEIPT_ASSIGN','PUTAWAY','MOVE',
      'PICK','SHIP','RETURN_ASSIGN','ADJUSTMENT'
    )),
  from_location_id uuid REFERENCES warehouse_location(id) ON DELETE RESTRICT,
  to_location_id uuid REFERENCES warehouse_location(id) ON DELETE RESTRICT,
  quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
  source_type text,
  source_id uuid,
  source_line_id uuid,
  idempotency_key text NOT NULL,
  actor_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,idempotency_key),
  CHECK (from_location_id IS NOT NULL OR to_location_id IS NOT NULL),
  CHECK (from_location_id IS DISTINCT FROM to_location_id)
);

CREATE INDEX wms_location_movement_sku_idx
  ON wms_location_movement(
    tenant_id,warehouse_id,sku_id,created_at DESC
  );

CREATE TABLE warehouse_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  task_type text NOT NULL
    CHECK (task_type IN (
      'PUTAWAY','MOVE','PICK','PACK','REPLENISH','COUNT'
    )),
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','CLAIMED','COMPLETED','CANCELLED','FAILED')),
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 10000),
  sku_id uuid REFERENCES sku(id) ON DELETE RESTRICT,
  quantity_milli bigint CHECK (quantity_milli IS NULL OR quantity_milli > 0),
  from_location_id uuid REFERENCES warehouse_location(id) ON DELETE RESTRICT,
  to_location_id uuid REFERENCES warehouse_location(id) ON DELETE RESTRICT,
  source_type text,
  source_id uuid,
  source_line_id uuid,
  assigned_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  claimed_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  claimed_at timestamptz,
  completed_at timestamptz,
  idempotency_key text NOT NULL,
  instructions jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,idempotency_key)
);

CREATE INDEX warehouse_task_queue_idx
  ON warehouse_task(
    tenant_id,warehouse_id,status,priority,created_at
  )
  WHERE status IN ('OPEN','CLAIMED');

ALTER TABLE warehouse_location_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_location_movement ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_task ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'warehouse_location_balance',
    'wms_location_movement',
    'warehouse_task'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      tbl || '_isolation',
      tbl
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION corebiz_wms_receive_unassigned(
  p_tenant_id uuid,
  p_warehouse_id uuid,
  p_sku_id uuid,
  p_quantity_milli bigint,
  p_source_type text,
  p_source_id uuid,
  p_source_line_id uuid,
  p_idempotency_key text,
  p_actor_membership_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_location_id uuid;
  v_movement_id uuid;
BEGIN
  IF p_quantity_milli <= 0 THEN
    RAISE EXCEPTION 'WMS_RECEIPT_QUANTITY_INVALID';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM warehouse_wms_profile p
    WHERE p.tenant_id=p_tenant_id
      AND p.warehouse_id=p_warehouse_id
      AND p.status='ACTIVE'
      AND p.stock_tracking_state='LOCATION_LEDGER'
  ) THEN
    RETURN NULL;
  END IF;

  SELECT l.id
  INTO v_location_id
  FROM warehouse_location l
  WHERE l.tenant_id=p_tenant_id
    AND l.warehouse_id=p_warehouse_id
    AND l.is_system=true
    AND l.code='UNASSIGNED'
    AND l.status='ACTIVE'
  LIMIT 1;

  IF v_location_id IS NULL THEN
    RAISE EXCEPTION 'WMS_UNASSIGNED_LOCATION_MISSING';
  END IF;

  SELECT id
  INTO v_movement_id
  FROM wms_location_movement
  WHERE tenant_id=p_tenant_id
    AND idempotency_key=p_idempotency_key;

  IF v_movement_id IS NOT NULL THEN
    RETURN v_movement_id;
  END IF;

  INSERT INTO warehouse_location_balance(
    tenant_id,warehouse_id,location_id,sku_id,physical_milli
  )
  VALUES (
    p_tenant_id,p_warehouse_id,v_location_id,p_sku_id,p_quantity_milli
  )
  ON CONFLICT (tenant_id,warehouse_id,location_id,sku_id)
  DO UPDATE SET
    physical_milli=
      warehouse_location_balance.physical_milli+
      EXCLUDED.physical_milli,
    updated_at=now();

  INSERT INTO wms_location_movement(
    tenant_id,warehouse_id,sku_id,movement_type,
    to_location_id,quantity_milli,
    source_type,source_id,source_line_id,
    idempotency_key,actor_membership_id
  )
  VALUES (
    p_tenant_id,p_warehouse_id,p_sku_id,'RECEIPT_ASSIGN',
    v_location_id,p_quantity_milli,
    p_source_type,p_source_id,p_source_line_id,
    p_idempotency_key,p_actor_membership_id
  )
  RETURNING id INTO v_movement_id;

  RETURN v_movement_id;
END;
$$;

REVOKE ALL ON FUNCTION corebiz_wms_receive_unassigned(
  uuid,uuid,uuid,bigint,text,uuid,uuid,text,uuid
) FROM PUBLIC;

COMMIT;
