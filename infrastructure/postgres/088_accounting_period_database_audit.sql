-- Sprint 51: fail-closed period audit at the database boundary.
-- The API supplies transaction-local actor and reason; PostgreSQL writes the immutable audit.
BEGIN;

CREATE OR REPLACE FUNCTION corebiz_accounting_period_state_audit()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
 v_reason text;
 v_actor uuid;
BEGIN
 IF NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NEW; END IF;
 v_reason := nullif(btrim(current_setting('app.accounting_period_reason',true)),'');
 v_actor := nullif(current_setting('app.accounting_period_actor',true),'')::uuid;
 IF v_reason IS NULL OR length(v_reason)<8 OR v_actor IS NULL THEN
   RAISE EXCEPTION 'Accounting period transition requires audited reason and actor'
     USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS (
   SELECT 1 FROM tenant_membership m WHERE m.id=v_actor AND m.tenant_id=NEW.tenant_id
 ) THEN
   RAISE EXCEPTION 'Accounting period transition actor tenant mismatch'
     USING ERRCODE='23514';
 END IF;
 IF NOT (
    (OLD.state='OPEN' AND NEW.state='SOFT_LOCKED') OR
    (OLD.state='SOFT_LOCKED' AND NEW.state='HARD_LOCKED')
 ) THEN
    RAISE EXCEPTION 'Illegal accounting period transition' USING ERRCODE='23514';
 END IF;
 INSERT INTO accounting_period_transition(
   tenant_id,period_id,from_state,to_state,reason,actor_membership_id
 ) VALUES (NEW.tenant_id,NEW.id,OLD.state,NEW.state,v_reason,v_actor);
 RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_period_auto_audit_v1
 AFTER UPDATE OF state ON accounting_period
 FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
 EXECUTE FUNCTION corebiz_accounting_period_state_audit();

COMMIT;
