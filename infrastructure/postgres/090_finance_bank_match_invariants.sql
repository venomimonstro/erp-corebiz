-- Sprint 52b: a posted payment may reconcile to at most one bank line.
BEGIN;
DO $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM finance_bank_statement_line
  WHERE payment_id IS NOT NULL GROUP BY tenant_id,payment_id HAVING count(*)>1
 ) THEN
  RAISE EXCEPTION 'Duplicate bank-to-payment links require manual reconciliation';
 END IF;
END;
$$;
CREATE UNIQUE INDEX finance_bank_payment_once_uq
 ON finance_bank_statement_line(tenant_id,payment_id)
 WHERE payment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION corebiz_bank_line_match_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Bank statement line deletion is forbidden' USING ERRCODE='23514';
 END IF;
 IF (
   to_jsonb(NEW)-'payment_id'
 ) IS DISTINCT FROM (
   to_jsonb(OLD)-'payment_id'
 ) THEN
  RAISE EXCEPTION 'Imported bank statement line is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.payment_id IS NOT NULL AND NEW.payment_id IS DISTINCT FROM OLD.payment_id THEN
  RAISE EXCEPTION 'Existing bank payment match cannot be replaced' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER finance_bank_line_match_guard_v1
 BEFORE UPDATE OR DELETE ON finance_bank_statement_line
 FOR EACH ROW EXECUTE FUNCTION corebiz_bank_line_match_guard();

CREATE OR REPLACE FUNCTION corebiz_bank_statement_state_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Imported bank statement deletion is forbidden' USING ERRCODE='23514';
 END IF;
 IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN
  RAISE EXCEPTION 'Imported bank statement header is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.status<>'IMPORTED' AND NEW.status IS DISTINCT FROM OLD.status THEN
  RAISE EXCEPTION 'Final bank statement status cannot change' USING ERRCODE='23514';
 END IF;
 IF NEW.status='RECONCILED' AND EXISTS(
  SELECT 1 FROM finance_bank_statement_line l
  WHERE l.statement_id=NEW.id AND l.tenant_id=NEW.tenant_id AND l.payment_id IS NULL
 ) THEN
  RAISE EXCEPTION 'Cannot reconcile bank statement with unmatched lines' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER finance_bank_statement_state_guard_v1
 BEFORE UPDATE OR DELETE ON finance_bank_statement
 FOR EACH ROW EXECUTE FUNCTION corebiz_bank_statement_state_guard();
COMMIT;
