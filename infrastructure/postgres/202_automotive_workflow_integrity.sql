BEGIN;

ALTER TABLE automotive_work_order_line
  DROP CONSTRAINT IF EXISTS automotive_work_order_line_completed_requires_approved_ck;

ALTER TABLE automotive_work_order_line
  ADD CONSTRAINT automotive_work_order_line_completed_requires_approved_ck
  CHECK (NOT completed OR approved);

CREATE OR REPLACE FUNCTION corebiz_automotive_work_order_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  allowed boolean:=false;
BEGIN
  IF TG_OP='INSERT' OR NEW.status=OLD.status THEN
    RETURN NEW;
  END IF;

  allowed:=CASE OLD.status
    WHEN 'DRAFT' THEN NEW.status IN ('DIAGNOSIS','CANCELLED')
    WHEN 'DIAGNOSIS' THEN NEW.status IN (
      'WAITING_APPROVAL','WAITING_PARTS','IN_PROGRESS','CANCELLED'
    )
    WHEN 'WAITING_APPROVAL' THEN NEW.status IN (
      'WAITING_PARTS','IN_PROGRESS','CANCELLED'
    )
    WHEN 'WAITING_PARTS' THEN NEW.status IN ('IN_PROGRESS','CANCELLED')
    WHEN 'IN_PROGRESS' THEN NEW.status IN (
      'QUALITY_CHECK','WAITING_PARTS','CANCELLED'
    )
    WHEN 'QUALITY_CHECK' THEN NEW.status IN ('READY','IN_PROGRESS')
    WHEN 'READY' THEN NEW.status IN ('DELIVERED','IN_PROGRESS')
    ELSE false
  END;

  IF NOT allowed THEN
    RAISE EXCEPTION 'AUTOMOTIVE_WORK_ORDER_INVALID_TRANSITION: % -> %',
      OLD.status,NEW.status
      USING ERRCODE='23514';
  END IF;

  IF NEW.status='DELIVERED' AND EXISTS(
    SELECT 1
    FROM automotive_work_order_line l
    WHERE l.tenant_id=NEW.tenant_id
      AND l.work_order_id=NEW.id
      AND l.approved=true
      AND l.completed=false
  ) THEN
    RAISE EXCEPTION 'AUTOMOTIVE_WORK_ORDER_UNFINISHED_LINES'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS automotive_work_order_transition_guard_v1
  ON automotive_work_order;
CREATE TRIGGER automotive_work_order_transition_guard_v1
BEFORE UPDATE OF status ON automotive_work_order
FOR EACH ROW EXECUTE FUNCTION corebiz_automotive_work_order_transition_guard();

COMMIT;
