-- Sprint 52: do not finalize empty bank statements.
BEGIN;
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
 IF NEW.status='RECONCILED' AND OLD.status IS DISTINCT FROM NEW.status THEN
  IF NOT EXISTS(
   SELECT 1 FROM finance_bank_statement_line l
   WHERE l.statement_id=NEW.id AND l.tenant_id=NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'Cannot reconcile an empty bank statement' USING ERRCODE='23514';
  END IF;
  IF EXISTS(
   SELECT 1 FROM finance_bank_statement_line l
   WHERE l.statement_id=NEW.id AND l.tenant_id=NEW.tenant_id AND l.payment_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot reconcile bank statement with unmatched lines' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;$$;
COMMIT;
