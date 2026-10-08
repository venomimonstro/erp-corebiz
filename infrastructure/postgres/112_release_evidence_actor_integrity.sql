BEGIN;
CREATE OR REPLACE FUNCTION corebiz_release_evidence_actor_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(
 SELECT 1 FROM tenant_membership m
 WHERE m.tenant_id=NEW.tenant_id AND m.id=NEW.executed_by_membership_id
 ) THEN RAISE EXCEPTION 'Release evidence actor tenant mismatch'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER release_evidence_actor_guard_v1 BEFORE INSERT ON release_verification_record
FOR EACH ROW EXECUTE FUNCTION corebiz_release_evidence_actor_guard();
COMMIT;