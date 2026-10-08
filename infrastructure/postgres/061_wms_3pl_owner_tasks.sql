BEGIN;

ALTER TABLE warehouse_task
  ADD COLUMN IF NOT EXISTS owner_id uuid
  REFERENCES inventory_owner(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS warehouse_task_owner_idx
  ON warehouse_task(
    tenant_id,warehouse_id,owner_id,status,task_type,created_at
  )
  WHERE owner_id IS NOT NULL;

UPDATE warehouse_task t
SET owner_id=a.owner_id
FROM wms_pick_allocation a
WHERE a.tenant_id=t.tenant_id
  AND a.id=t.source_line_id
  AND t.task_type='PICK'
  AND t.source_type='SALES_ORDER'
  AND t.owner_id IS NULL;

UPDATE warehouse_task t
SET owner_id=so.inventory_owner_id
FROM sales_order so
WHERE so.tenant_id=t.tenant_id
  AND so.id=t.source_id
  AND t.task_type IN ('PACK','SHIP')
  AND t.source_type='SALES_ORDER'
  AND t.owner_id IS NULL;

COMMIT;
