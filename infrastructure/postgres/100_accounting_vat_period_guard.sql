BEGIN;
CREATE OR REPLACE FUNCTION corebiz_vat_period_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM legal_entity e WHERE e.id=NEW.legal_entity_id AND e.tenant_id=NEW.tenant_id)
 THEN RAISE EXCEPTION 'VAT legal entity mismatch'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || NEW.legal_entity_id::text || 'vat',0));
 IF EXISTS (SELECT 1 FROM accounting_vat_period p WHERE p.tenant_id=NEW.tenant_id
 AND p.legal_entity_id=NEW.legal_entity_id AND p.id IS DISTINCT FROM NEW.id
 AND p.date_from<=NEW.date_to AND NEW.date_from<=p.date_to)
 THEN RAISE EXCEPTION 'VAT periods overlap'; END IF;
 IF TG_OP='UPDATE' THEN
   IF OLD.state='CLOSED' OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
   OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
   OR NEW.date_from IS DISTINCT FROM OLD.date_from OR NEW.date_to IS DISTINCT FROM OLD.date_to
   THEN RAISE EXCEPTION 'VAT period identity is immutable'; END IF;
   IF NEW.state='CLOSED' AND (NEW.closed_by_membership_id IS NULL OR NEW.closed_at IS NULL
      OR length(btrim(coalesce(NEW.close_reason,'')))<12)
   THEN RAISE EXCEPTION 'VAT closing requires auditor and reason'; END IF;
 END IF;
 IF NEW.closed_by_membership_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM tenant_membership m WHERE m.id=NEW.closed_by_membership_id AND m.tenant_id=NEW.tenant_id)
 THEN RAISE EXCEPTION 'VAT closing actor mismatch'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER vat_period_guard_v1 BEFORE INSERT OR UPDATE ON accounting_vat_period
FOR EACH ROW EXECUTE FUNCTION corebiz_vat_period_guard();
COMMIT;