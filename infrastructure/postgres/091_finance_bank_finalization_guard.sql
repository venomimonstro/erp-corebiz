-- Sprint 52c: finalized bank statements cannot accept new imported lines.
BEGIN;
CREATE OR REPLACE FUNCTION corebiz_bank_line_open_statement_only()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM finance_bank_statement s
  WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.statement_id
    AND s.status='IMPORTED'
  FOR UPDATE
 ) THEN
  RAISE EXCEPTION 'Cannot add a bank line to a finalized statement'
    USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;$$;

CREATE TRIGGER finance_bank_line_open_statement_v1
BEFORE INSERT ON finance_bank_statement_line FOR EACH ROW
EXECUTE FUNCTION corebiz_bank_line_open_statement_only();
COMMIT;
