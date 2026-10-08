-- Sprint 52d: matched bank payments cannot be silently reversed.
-- A correction must first use an audited bank reconciliation correction workflow.
BEGIN;
CREATE OR REPLACE FUNCTION corebiz_guard_bank_matched_payment_status()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.status IS DISTINCT FROM OLD.status
    AND NEW.status<>'POSTED'
    AND EXISTS(
      SELECT 1 FROM finance_bank_statement_line l
      WHERE l.tenant_id=OLD.tenant_id AND l.payment_id=OLD.id
    ) THEN
   RAISE EXCEPTION 'Bank-matched payment cannot be reversed without reconciliation correction'
     USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER finance_bank_matched_payment_status_guard_v1
 BEFORE UPDATE OF status ON payment FOR EACH ROW
 EXECUTE FUNCTION corebiz_guard_bank_matched_payment_status();
COMMIT;
