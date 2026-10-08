BEGIN;
-- For VAT bookkeeping, document date and register date must resolve to the same period.
CREATE OR REPLACE FUNCTION corebiz_vat_register_period_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_document_date date;
BEGIN
 SELECT d.document_date INTO v_document_date
 FROM accounting_vat_document d
 WHERE d.id=NEW.vat_document_id AND d.tenant_id=NEW.tenant_id
   AND d.legal_entity_id=NEW.legal_entity_id;
 IF v_document_date IS NULL THEN RAISE EXCEPTION 'VAT source document missing'; END IF;
 IF NOT EXISTS (
  SELECT 1 FROM accounting_vat_period p
  WHERE p.tenant_id=NEW.tenant_id AND p.legal_entity_id=NEW.legal_entity_id
    AND p.state='OPEN'
    AND NEW.event_date BETWEEN p.date_from AND p.date_to
    AND v_document_date BETWEEN p.date_from AND p.date_to
  FOR UPDATE
 ) THEN RAISE EXCEPTION 'VAT registration date and document date need one open period'; END IF;
 RETURN NEW;
END;
$$;
COMMIT;