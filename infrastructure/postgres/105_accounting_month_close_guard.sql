BEGIN;
CREATE OR REPLACE FUNCTION corebiz_month_close_check_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.checked_by_membership_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM tenant_membership m
   WHERE m.tenant_id=NEW.tenant_id AND m.id=NEW.checked_by_membership_id
 ) THEN RAISE EXCEPTION 'Month-close reviewer must belong to tenant'; END IF;
 IF NEW.status='DONE' AND (NEW.checked_by_membership_id IS NULL OR NEW.checked_at IS NULL)
 THEN RAISE EXCEPTION 'Completed month-close check requires reviewer and timestamp'; END IF;
 IF NOT EXISTS (
   SELECT 1 FROM accounting_period p
   WHERE p.id=NEW.period_id AND p.tenant_id=NEW.tenant_id
     AND p.state<>'HARD_LOCKED'
   FOR UPDATE
 ) THEN RAISE EXCEPTION 'Cannot change checklist in hard-locked period'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER accounting_month_close_check_guard_v1
BEFORE INSERT OR UPDATE ON accounting_month_close_check
FOR EACH ROW EXECUTE FUNCTION corebiz_month_close_check_guard();
COMMIT;