BEGIN;

CREATE OR REPLACE FUNCTION corebiz_payroll_component_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  v_tenant uuid;
  v_batch uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    v_tenant:=OLD.tenant_id;
    v_batch:=OLD.batch_id;
  ELSE
    v_tenant:=NEW.tenant_id;
    v_batch:=NEW.batch_id;
  END IF;

  IF NOT EXISTS(
    SELECT 1
    FROM payroll_accrual_batch b
    WHERE b.tenant_id=v_tenant
      AND b.id=v_batch
      AND b.status='DRAFT'
    FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'Payroll component modifications require draft batch';
  END IF;

  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
