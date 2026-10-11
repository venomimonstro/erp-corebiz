BEGIN;

ALTER TABLE trainer_payroll_statement
  ADD COLUMN IF NOT EXISTS payroll_batch_id uuid
    REFERENCES payroll_accrual_batch(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS exported_at timestamptz;

ALTER TABLE trainer_payroll_statement
  DROP CONSTRAINT IF EXISTS trainer_payroll_statement_status_check;

ALTER TABLE trainer_payroll_statement
  ADD CONSTRAINT trainer_payroll_statement_status_check
  CHECK (status IN ('DRAFT','FINALIZED','EXPORTED','PAID','CANCELLED'));

CREATE INDEX IF NOT EXISTS trainer_payroll_statement_export_idx
  ON trainer_payroll_statement(tenant_id,status,period_from,payroll_batch_id);

CREATE OR REPLACE FUNCTION corebiz_trainer_payroll_statement_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF OLD.status IN ('EXPORTED','PAID','CANCELLED') THEN
    IF NEW.trainer_resource_id IS DISTINCT FROM OLD.trainer_resource_id
       OR NEW.period_from IS DISTINCT FROM OLD.period_from
       OR NEW.period_to IS DISTINCT FROM OLD.period_to
       OR NEW.lesson_accrual_minor IS DISTINCT FROM OLD.lesson_accrual_minor
       OR NEW.base_minor IS DISTINCT FROM OLD.base_minor
       OR NEW.guarantee_adjustment_minor IS DISTINCT FROM OLD.guarantee_adjustment_minor
       OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.calculation_snapshot IS DISTINCT FROM OLD.calculation_snapshot THEN
      RAISE EXCEPTION 'TRAINER_PAYROLL_STATEMENT_IMMUTABLE';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trainer_payroll_statement_immutable_v1
  ON trainer_payroll_statement;
CREATE TRIGGER trainer_payroll_statement_immutable_v1
BEFORE UPDATE ON trainer_payroll_statement
FOR EACH ROW EXECUTE FUNCTION corebiz_trainer_payroll_statement_immutable();

COMMIT;
