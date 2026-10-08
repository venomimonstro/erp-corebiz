BEGIN;

CREATE INDEX IF NOT EXISTS warehouse_task_active_dispatch_idx
  ON warehouse_task(
    tenant_id,warehouse_id,status,task_type,priority,created_at
  )
  WHERE status IN ('OPEN','CLAIMED','BLOCKED','FAILED');

CREATE INDEX IF NOT EXISTS wms_location_movement_pick_history_idx
  ON wms_location_movement(
    tenant_id,warehouse_id,movement_type,created_at DESC,sku_id
  );

CREATE INDEX IF NOT EXISTS warehouse_location_balance_slotting_idx
  ON warehouse_location_balance(
    tenant_id,warehouse_id,sku_id,physical_milli,location_id
  )
  WHERE physical_milli>0;

CREATE TABLE wms_slotting_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  lookback_days integer NOT NULL DEFAULT 30
    CHECK (lookback_days BETWEEN 7 AND 180),
  status text NOT NULL DEFAULT 'COMPLETED'
    CHECK (status IN ('COMPLETED','ARCHIVED')),
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX wms_slotting_run_recent_idx
  ON wms_slotting_run(tenant_id,warehouse_id,created_at DESC);

CREATE TABLE wms_slotting_recommendation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES wms_slotting_run(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
  source_location_id uuid NOT NULL REFERENCES warehouse_location(id) ON DELETE RESTRICT,
  target_location_id uuid NOT NULL REFERENCES warehouse_location(id) ON DELETE RESTRICT,
  suggested_quantity_milli bigint NOT NULL CHECK (suggested_quantity_milli > 0),
  pick_events integer NOT NULL DEFAULT 0 CHECK (pick_events >= 0),
  picked_quantity_milli bigint NOT NULL DEFAULT 0 CHECK (picked_quantity_milli >= 0),
  score numeric(14,4) NOT NULL DEFAULT 0,
  reason jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'PROPOSED'
    CHECK (status IN ('PROPOSED','TASK_CREATED','DISMISSED')),
  move_task_id uuid REFERENCES warehouse_task(id) ON DELETE SET NULL,
  acted_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  acted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id,sku_id)
);

CREATE INDEX wms_slotting_recommendation_queue_idx
  ON wms_slotting_recommendation(
    tenant_id,warehouse_id,status,score DESC,created_at DESC
  );

ALTER TABLE wms_slotting_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_slotting_recommendation ENABLE ROW LEVEL SECURITY;

CREATE POLICY wms_slotting_run_isolation
  ON wms_slotting_run
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE POLICY wms_slotting_recommendation_isolation
  ON wms_slotting_recommendation
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

COMMIT;
