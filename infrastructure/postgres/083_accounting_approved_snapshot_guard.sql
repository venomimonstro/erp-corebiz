-- Sprint 51d: once approved, accounting policy/rule snapshots cannot be edited.
BEGIN;
CREATE OR REPLACE FUNCTION corebiz_accounting_approved_snapshot_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Accounting rule/policy deletion forbidden' USING ERRCODE='23514';
 END IF;
 IF OLD.status IN ('APPROVED','RETIRED') AND (
   to_jsonb(NEW)-'status' IS DISTINCT FROM to_jsonb(OLD)-'status'
   OR (OLD.status='RETIRED' AND NEW.status<>'RETIRED')
   OR (OLD.status='APPROVED' AND NEW.status NOT IN ('APPROVED','RETIRED'))
 ) THEN
   RAISE EXCEPTION 'Approved accounting snapshot immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER accounting_policy_approved_guard_v1 BEFORE UPDATE OR DELETE ON accounting_policy
 FOR EACH ROW EXECUTE FUNCTION corebiz_accounting_approved_snapshot_guard();
CREATE TRIGGER accounting_rule_approved_guard_v1 BEFORE UPDATE OR DELETE ON accounting_posting_rule
 FOR EACH ROW EXECUTE FUNCTION corebiz_accounting_approved_snapshot_guard();
COMMIT;
