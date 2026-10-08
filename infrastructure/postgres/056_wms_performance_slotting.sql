BEGIN;

CREATE INDEX IF NOT EXISTS warehouse_task_labor_completed_idx
  ON warehouse_task(
    tenant_id,warehouse_id,completed_at DESC,
    task_type,claimed_by_membership_id
  )
  WHERE status='COMPLETED';

CREATE INDEX IF NOT EXISTS warehouse_task_active_age_idx
  ON warehouse_task(
    tenant_id,warehouse_id,status,created_at,priority
  )
  WHERE status IN ('OPEN','CLAIMED','BLOCKED','FAILED');

CREATE INDEX IF NOT EXISTS warehouse_task_operator_active_idx
  ON warehouse_task(
    tenant_id,claimed_by_membership_id,status,claimed_at
  )
  WHERE status='CLAIMED';

CREATE INDEX IF NOT EXISTS wms_pick_velocity_idx
  ON wms_location_movement(
    tenant_id,warehouse_id,sku_id,created_at DESC
  )
  INCLUDE (quantity_milli,from_location_id)
  WHERE movement_type='PICK';

CREATE INDEX IF NOT EXISTS warehouse_location_active_pick_idx
  ON warehouse_location(
    tenant_id,warehouse_id,zone_id,pick_sequence,id
  )
  WHERE status='ACTIVE' AND is_system=false;

COMMIT;
