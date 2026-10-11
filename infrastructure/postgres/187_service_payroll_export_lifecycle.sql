BEGIN;

ALTER TABLE service_employee_payroll_statement
  ADD COLUMN IF NOT EXISTS payroll_batch_id uuid
    REFERENCES payroll_accrual_batch(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS exported_at timestamptz;

ALTER TABLE service_employee_booking_accrual
  ADD COLUMN IF NOT EXISTS payroll_batch_id uuid
    REFERENCES payroll_accrual_batch(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION corebiz_payroll_batch_paid_sync()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NEW.status='PAID' AND OLD.status IS DISTINCT FROM 'PAID' THEN
    UPDATE trainer_payroll_statement
    SET status='PAID',
        paid_at=coalesce(NEW.paid_at,now()),
        updated_at=now()
    WHERE tenant_id=NEW.tenant_id
      AND payroll_batch_id=NEW.id
      AND status='EXPORTED';

    UPDATE service_employee_payroll_statement
    SET status='PAID',
        paid_at=coalesce(NEW.paid_at,now()),
        updated_at=now()
    WHERE tenant_id=NEW.tenant_id
      AND payroll_batch_id=NEW.id
      AND status='EXPORTED';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payroll_batch_paid_sync_v1
  ON payroll_accrual_batch;
CREATE TRIGGER payroll_batch_paid_sync_v2
AFTER UPDATE OF status,paid_at
ON payroll_accrual_batch
FOR EACH ROW EXECUTE FUNCTION corebiz_payroll_batch_paid_sync();

CREATE TRIGGER service_employee_statement_tenant_refs_v2
BEFORE INSERT OR UPDATE ON service_employee_payroll_statement
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'employee_resource_id','service_resource',
  'payroll_batch_id','payroll_accrual_batch'
);

CREATE TRIGGER service_employee_accrual_tenant_refs_v2
BEFORE INSERT OR UPDATE ON service_employee_booking_accrual
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'booking_id','service_booking',
  'employee_resource_id','service_resource',
  'plan_id','service_employee_compensation_plan',
  'payroll_batch_id','payroll_accrual_batch'
);

COMMIT;
