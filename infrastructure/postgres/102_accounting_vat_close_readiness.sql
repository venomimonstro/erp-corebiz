BEGIN;
CREATE OR REPLACE FUNCTION corebiz_vat_close_readiness()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='OPEN' AND NEW.state='CLOSED' AND EXISTS (
  SELECT 1 FROM accounting_vat_document d
  WHERE d.tenant_id=NEW.tenant_id AND d.legal_entity_id=NEW.legal_entity_id
   AND d.document_date BETWEEN NEW.date_from AND NEW.date_to
   AND d.status='APPROVED'
   AND NOT EXISTS(SELECT 1 FROM accounting_vat_register r
     WHERE r.tenant_id=d.tenant_id AND r.vat_document_id=d.id)
 ) THEN
  RAISE EXCEPTION 'VAT close blocked by approved unregistered documents';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER vat_close_readiness_v1 BEFORE UPDATE OF state ON accounting_vat_period
FOR EACH ROW EXECUTE FUNCTION corebiz_vat_close_readiness();
COMMIT;