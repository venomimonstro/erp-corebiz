BEGIN;
CREATE OR REPLACE FUNCTION corebiz_payroll_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_batch uuid; v_tenant uuid;
BEGIN
 IF TG_OP='DELETE' THEN
   v_batch:=OLD.batch_id; v_tenant:=OLD.tenant_id;
 ELSE
   v_batch:=NEW.batch_id; v_tenant:=NEW.tenant_id;
 END IF;
 IF NOT EXISTS(
  SELECT 1 FROM payroll_accrual_batch b
  WHERE b.id=v_batch AND b.tenant_id=v_tenant AND b.status='DRAFT'
  FOR UPDATE
 ) THEN RAISE EXCEPTION 'Payroll line modifications require draft batch'; END IF;
 IF TG_OP='UPDATE' AND (
   NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
   NEW.batch_id IS DISTINCT FROM OLD.batch_id OR
   NEW.employee_ref IS DISTINCT FROM OLD.employee_ref
 ) THEN RAISE EXCEPTION 'Payroll line identity cannot change'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;$$;
COMMIT;