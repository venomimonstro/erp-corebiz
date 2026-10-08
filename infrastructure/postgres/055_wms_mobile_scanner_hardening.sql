BEGIN;

ALTER TABLE wms_task_scan
  DROP CONSTRAINT IF EXISTS wms_task_scan_scan_kind_check;

ALTER TABLE wms_task_scan
  ADD CONSTRAINT wms_task_scan_scan_kind_check
  CHECK (scan_kind IN ('FROM_LOCATION','SKU','TO_LOCATION','ORDER'));

ALTER TABLE wms_task_scan
  ADD COLUMN IF NOT EXISTS matched_value text;

UPDATE wms_task_scan
SET matched_value=scanned_value
WHERE matched_value IS NULL;

ALTER TABLE wms_task_scan
  ALTER COLUMN matched_value SET NOT NULL;

CREATE INDEX IF NOT EXISTS wms_task_scan_actor_idx
  ON wms_task_scan(tenant_id,actor_membership_id,scanned_at DESC);

COMMIT;
