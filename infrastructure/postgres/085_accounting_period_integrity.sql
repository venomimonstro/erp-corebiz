-- Sprint 51f: period overlap and posted-period immutability guard.
BEGIN;
CREATE OR REPLACE FUNCTION corebiz_accounting_period_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM legal_entity le
   WHERE le.id=NEW.legal_entity_id AND le.tenant_id=NEW.tenant_id
 ) THEN
   RAISE EXCEPTION 'Accounting period legal entity tenant mismatch'
    USING ERRCODE='23514';
 END IF;
 -- Serialize period configuration per legal entity for concurrent inserts.
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':'||NEW.legal_entity_id::text,0));
 IF EXISTS (
   SELECT 1 FROM accounting_period p
   WHERE p.tenant_id=NEW.tenant_id
     AND p.legal_entity_id=NEW.legal_entity_id
     AND p.id IS DISTINCT FROM NEW.id
     AND p.date_from<=NEW.date_to AND p.date_to>=NEW.date_from
 ) THEN
   RAISE EXCEPTION 'Overlapping accounting periods are forbidden'
     USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' THEN
   IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
      OR NEW.date_from IS DISTINCT FROM OLD.date_from
      OR NEW.date_to IS DISTINCT FROM OLD.date_to THEN
     RAISE EXCEPTION 'Accounting period identity/dates are immutable'
       USING ERRCODE='23514';
   END IF;
   IF OLD.state='HARD_LOCKED' AND NEW.state<>'HARD_LOCKED' THEN
     RAISE EXCEPTION 'Hard lock requires dedicated audited reopen workflow'
       USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER accounting_period_guard_v1
BEFORE INSERT OR UPDATE ON accounting_period
FOR EACH ROW EXECUTE FUNCTION corebiz_accounting_period_guard();
COMMIT;
