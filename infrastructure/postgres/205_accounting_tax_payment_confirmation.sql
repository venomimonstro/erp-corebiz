BEGIN;

ALTER TABLE accounting_compliance_obligation
  DROP CONSTRAINT IF EXISTS accounting_compliance_obligation_workflow_status_check;

ALTER TABLE accounting_compliance_obligation
  ADD CONSTRAINT accounting_compliance_obligation_workflow_status_check
  CHECK(workflow_status IN (
    'PLANNED','READY','APPROVED','SUBMITTED','ACCEPTED',
    'REJECTED','PAYMENT_PENDING','PAID','CANCELLED'
  ));

ALTER TABLE accounting_compliance_obligation
  ADD COLUMN IF NOT EXISTS payment_id uuid
    REFERENCES payment(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_initiated_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_confirmation_source text,
  ADD COLUMN IF NOT EXISTS payment_confirmation_reference text;

CREATE INDEX IF NOT EXISTS accounting_compliance_payment_pending_idx
  ON accounting_compliance_obligation(
    tenant_id,legal_entity_id,due_at
  )
  WHERE workflow_status='PAYMENT_PENDING';

CREATE OR REPLACE FUNCTION corebiz_accounting_compliance_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF TG_OP='UPDATE'
     AND NEW.workflow_status IS DISTINCT FROM OLD.workflow_status THEN
    IF NOT (
      (OLD.workflow_status='PLANNED'
        AND NEW.workflow_status IN ('READY','CANCELLED'))
      OR (OLD.workflow_status='READY'
        AND NEW.workflow_status IN ('APPROVED','CANCELLED'))
      OR (OLD.workflow_status='APPROVED'
        AND NEW.workflow_status IN (
          'SUBMITTED','PAYMENT_PENDING','PAID','CANCELLED'
        ))
      OR (OLD.workflow_status='PAYMENT_PENDING'
        AND NEW.workflow_status IN ('PAID','APPROVED','CANCELLED'))
      OR (OLD.workflow_status='SUBMITTED'
        AND NEW.workflow_status IN ('ACCEPTED','REJECTED','PAID'))
      OR (OLD.workflow_status='REJECTED'
        AND NEW.workflow_status IN ('READY','CANCELLED'))
      OR (OLD.workflow_status=NEW.workflow_status)
    ) THEN
      RAISE EXCEPTION 'ACCOUNTING_COMPLIANCE_INVALID_TRANSITION'
        USING ERRCODE='23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounting_compliance_transition_guard_v2
  ON accounting_compliance_obligation;
DROP TRIGGER IF EXISTS accounting_compliance_transition_guard_v1
  ON accounting_compliance_obligation;
CREATE TRIGGER accounting_compliance_transition_guard_v3
BEFORE UPDATE OF workflow_status
ON accounting_compliance_obligation
FOR EACH ROW
EXECUTE FUNCTION corebiz_accounting_compliance_transition_guard();

CREATE OR REPLACE FUNCTION corebiz_accounting_tax_payment_state_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NEW.obligation_type='PAY'
     AND NEW.workflow_status='PAYMENT_PENDING'
     AND (
       NEW.payment_id IS NULL
       OR NEW.payment_initiated_at IS NULL
     ) THEN
    RAISE EXCEPTION 'ACCOUNTING_TAX_PAYMENT_PENDING_EVIDENCE_REQUIRED'
      USING ERRCODE='23514';
  END IF;

  IF NEW.obligation_type='PAY'
     AND NEW.workflow_status='PAID'
     AND (
       NEW.payment_confirmed_at IS NULL
       OR nullif(btrim(NEW.payment_confirmation_source),'') IS NULL
       OR nullif(btrim(NEW.payment_confirmation_reference),'') IS NULL
     ) THEN
    RAISE EXCEPTION 'ACCOUNTING_TAX_PAYMENT_CONFIRMATION_REQUIRED'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounting_tax_payment_state_guard_v1
  ON accounting_compliance_obligation;
CREATE TRIGGER accounting_tax_payment_state_guard_v1
BEFORE INSERT OR UPDATE OF
  workflow_status,payment_id,payment_initiated_at,payment_confirmed_at,
  payment_confirmation_source,payment_confirmation_reference
ON accounting_compliance_obligation
FOR EACH ROW
EXECUTE FUNCTION corebiz_accounting_tax_payment_state_guard();

COMMIT;
