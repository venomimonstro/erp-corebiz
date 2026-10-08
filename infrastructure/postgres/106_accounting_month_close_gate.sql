BEGIN;
CREATE OR REPLACE FUNCTION corebiz_accounting_close_checklist_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='OPEN' AND NEW.state='SOFT_LOCKED' AND (
   SELECT count(*) FROM accounting_month_close_check c
   WHERE c.tenant_id=NEW.tenant_id AND c.period_id=NEW.id AND c.status='DONE'
 ) <> 7 THEN
  RAISE EXCEPTION 'All seven month-close checks must be DONE before locking';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER accounting_close_checklist_gate_v1
 BEFORE UPDATE OF state ON accounting_period
 FOR EACH ROW EXECUTE FUNCTION corebiz_accounting_close_checklist_gate();
COMMIT;