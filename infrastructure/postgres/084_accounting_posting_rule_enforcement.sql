-- Sprint 51e: approved, effective-dated rules become mandatory for NEW journal postings.
-- Existing historic entries remain unchanged.
BEGIN;

CREATE OR REPLACE FUNCTION corebiz_accounting_rule_approval_check()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.status='APPROVED' AND NOT EXISTS (
  SELECT 1 FROM accounting_policy p
  WHERE p.id=NEW.policy_id AND p.tenant_id=NEW.tenant_id
    AND p.status='APPROVED'
    AND NEW.valid_from>=p.valid_from
    AND (p.valid_to IS NULL OR (NEW.valid_to IS NOT NULL AND NEW.valid_to<=p.valid_to))
 ) THEN
  RAISE EXCEPTION 'Approved posting rule needs approved policy and covered validity interval'
   USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_rule_approval_check_v1
BEFORE INSERT OR UPDATE OF status,valid_from,valid_to,policy_id
ON accounting_posting_rule FOR EACH ROW
EXECUTE FUNCTION corebiz_accounting_rule_approval_check();

CREATE OR REPLACE FUNCTION corebiz_accounting_journal_rule_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM accounting_posting_rule r
  JOIN accounting_policy p ON p.id=r.policy_id AND p.tenant_id=r.tenant_id
  WHERE r.tenant_id=NEW.tenant_id
    AND p.legal_entity_id=NEW.legal_entity_id
    AND r.code=NEW.rule_code AND r.version=NEW.rule_version
    AND r.source_type=NEW.source_type
    AND r.debit_account_id=NEW.debit_account_id
    AND r.credit_account_id=NEW.credit_account_id
    AND r.status='APPROVED' AND p.status='APPROVED'
    AND NEW.business_date>=r.valid_from
    AND (r.valid_to IS NULL OR NEW.business_date<=r.valid_to)
    AND NEW.business_date>=p.valid_from
    AND (p.valid_to IS NULL OR NEW.business_date<=p.valid_to)
 ) THEN
  RAISE EXCEPTION 'No approved effective-dated posting rule for accounting entry'
   USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_journal_rule_guard_v1
BEFORE INSERT ON accounting_journal_entry
FOR EACH ROW EXECUTE FUNCTION corebiz_accounting_journal_rule_guard();

COMMIT;
