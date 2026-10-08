BEGIN;
CREATE OR REPLACE FUNCTION corebiz_payroll_batch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM legal_entity e WHERE e.id=NEW.legal_entity_id AND e.tenant_id=NEW.tenant_id)
 THEN RAISE EXCEPTION 'Payroll legal entity mismatch'; END IF;
 IF NEW.approved_by_membership_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM tenant_membership m WHERE m.id=NEW.approved_by_membership_id AND m.tenant_id=NEW.tenant_id
 ) THEN RAISE EXCEPTION 'Payroll approval actor mismatch'; END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.status='APPROVED' THEN RAISE EXCEPTION 'Approved payroll batch immutable'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
   OR NEW.period_from IS DISTINCT FROM OLD.period_from OR NEW.period_to IS DISTINCT FROM OLD.period_to
  THEN RAISE EXCEPTION 'Payroll batch identity immutable'; END IF;
 END IF;
 IF NEW.status='APPROVED' THEN
  IF NEW.approved_by_membership_id IS NULL OR NEW.approved_at IS NULL
  THEN RAISE EXCEPTION 'Approval requires actor and timestamp'; END IF;
  IF NOT EXISTS(SELECT 1 FROM payroll_accrual_line l WHERE l.tenant_id=NEW.tenant_id AND l.batch_id=NEW.id)
  THEN RAISE EXCEPTION 'Cannot approve empty payroll batch'; END IF;
 END IF;
 RETURN NEW;
END;$$;
COMMIT;