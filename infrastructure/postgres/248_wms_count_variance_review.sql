BEGIN;
-- CoreBiz WMS: counting a discrepancy is not authorization to write stock off.
-- Existing POSTED counts are preserved. Only new non-zero variances enter
-- REVIEW_REQUIRED and must be approved by a DIFFERENT membership.
ALTER TABLE wms_cycle_count_line
  DROP CONSTRAINT IF EXISTS wms_cycle_count_line_status_check;
ALTER TABLE wms_cycle_count_line
  ADD CONSTRAINT wms_cycle_count_line_status_check
  CHECK(status IN ('OPEN','REVIEW_REQUIRED','POSTED','CANCELLED'));
ALTER TABLE wms_cycle_count
  DROP CONSTRAINT IF EXISTS wms_cycle_count_status_check;
ALTER TABLE wms_cycle_count
  ADD CONSTRAINT wms_cycle_count_status_check
  CHECK(status IN ('OPEN','REVIEW_REQUIRED','POSTED','CANCELLED'));
ALTER TABLE wms_cycle_count_line
  ADD COLUMN IF NOT EXISTS counted_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_note text;
CREATE INDEX IF NOT EXISTS wms_count_review_queue
  ON wms_cycle_count_line(tenant_id,warehouse_id,count_id)
  WHERE status='REVIEW_REQUIRED';
COMMIT;
