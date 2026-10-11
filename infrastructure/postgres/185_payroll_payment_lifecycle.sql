BEGIN;

ALTER TABLE payroll_accrual_batch
  DROP CONSTRAINT IF EXISTS payroll_accrual_batch_status_check;

ALTER TABLE payroll_accrual_batch
  ADD CONSTRAINT payroll_accrual_batch_status_check
  CHECK (status IN ('DRAFT','APPROVED','PAID'));

ALTER TABLE payroll_accrual_batch
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS paid_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_reference text,
  ADD COLUMN IF NOT EXISTS payment_note text;

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
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payroll_batch_paid_sync_v1
  ON payroll_accrual_batch;
CREATE TRIGGER payroll_batch_paid_sync_v1
AFTER UPDATE OF status,paid_at
ON payroll_accrual_batch
FOR EACH ROW EXECUTE FUNCTION corebiz_payroll_batch_paid_sync();

CREATE TRIGGER payroll_batch_paid_by_tenant_refs_v1
BEFORE INSERT OR UPDATE ON payroll_accrual_batch
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'legal_entity_id','legal_entity',
  'approved_by_membership_id','tenant_membership',
  'paid_by_membership_id','tenant_membership'
);

COMMIT;
