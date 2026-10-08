BEGIN;
CREATE OR REPLACE FUNCTION corebiz_vat_register_period_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM accounting_vat_period p
  WHERE p.tenant_id=NEW.tenant_id AND p.legal_entity_id=NEW.legal_entity_id
  AND NEW.event_date BETWEEN p.date_from AND p.date_to AND p.state='OPEN'
  FOR UPDATE
 ) THEN RAISE EXCEPTION 'VAT registration requires an open VAT period'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER vat_register_period_guard_v1 BEFORE INSERT ON accounting_vat_register
FOR EACH ROW EXECUTE FUNCTION corebiz_vat_register_period_guard();
COMMIT;