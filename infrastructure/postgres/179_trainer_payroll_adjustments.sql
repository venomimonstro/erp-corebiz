BEGIN;

ALTER TABLE trainer_payroll_statement
  ADD COLUMN IF NOT EXISTS adjustment_minor bigint NOT NULL DEFAULT 0;

CREATE TABLE trainer_payroll_adjustment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  statement_id uuid NOT NULL
    REFERENCES trainer_payroll_statement(id) ON DELETE CASCADE,
  adjustment_type text NOT NULL
    CHECK (adjustment_type IN ('BONUS','DEDUCTION','CORRECTION','OTHER')),
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  reason text NOT NULL,
  created_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id)
);

CREATE INDEX trainer_payroll_adjustment_statement_idx
  ON trainer_payroll_adjustment(tenant_id,statement_id,created_at);

ALTER TABLE trainer_payroll_adjustment ENABLE ROW LEVEL SECURITY;
CREATE POLICY trainer_payroll_adjustment_isolation
  ON trainer_payroll_adjustment
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER trainer_payroll_adjustment_tenant_refs_v1
BEFORE INSERT OR UPDATE ON trainer_payroll_adjustment
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'statement_id','trainer_payroll_statement',
  'created_by_membership_id','tenant_membership'
);

CREATE OR REPLACE FUNCTION corebiz_trainer_payroll_adjustment_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  v_status text;
  v_current bigint;
BEGIN
  SELECT status,total_minor
  INTO v_status,v_current
  FROM trainer_payroll_statement
  WHERE tenant_id=NEW.tenant_id AND id=NEW.statement_id
  FOR UPDATE;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'TRAINER_PAYROLL_STATEMENT_MISSING';
  END IF;

  IF v_status <> 'FINALIZED' THEN
    RAISE EXCEPTION 'TRAINER_PAYROLL_STATEMENT_LOCKED';
  END IF;

  IF v_current + NEW.amount_minor < 0 THEN
    RAISE EXCEPTION 'TRAINER_PAYROLL_TOTAL_NEGATIVE';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trainer_payroll_adjustment_guard_v1
BEFORE INSERT ON trainer_payroll_adjustment
FOR EACH ROW EXECUTE FUNCTION corebiz_trainer_payroll_adjustment_guard();

CREATE OR REPLACE FUNCTION corebiz_apply_trainer_payroll_adjustment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  UPDATE trainer_payroll_statement
  SET adjustment_minor=adjustment_minor+NEW.amount_minor,
      total_minor=total_minor+NEW.amount_minor,
      updated_at=now()
  WHERE tenant_id=NEW.tenant_id
    AND id=NEW.statement_id
    AND status='FINALIZED';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRAINER_PAYROLL_STATEMENT_LOCKED';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trainer_payroll_adjustment_apply_v1
AFTER INSERT ON trainer_payroll_adjustment
FOR EACH ROW EXECUTE FUNCTION corebiz_apply_trainer_payroll_adjustment();

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
       OR NEW.adjustment_minor IS DISTINCT FROM OLD.adjustment_minor
       OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.calculation_snapshot IS DISTINCT FROM OLD.calculation_snapshot THEN
      RAISE EXCEPTION 'TRAINER_PAYROLL_STATEMENT_IMMUTABLE';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
