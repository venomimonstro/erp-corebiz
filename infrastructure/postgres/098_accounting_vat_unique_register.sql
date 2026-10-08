-- Sprint 53d: prevent two register directions for the same VAT document.
BEGIN;
DO $$
BEGIN
 IF EXISTS(
  SELECT 1 FROM accounting_vat_register
  GROUP BY tenant_id,vat_document_id HAVING count(*)>1
 ) THEN
  RAISE EXCEPTION 'VAT document has multiple register entries; reconcile before migrating';
 END IF;
END;$$;
CREATE UNIQUE INDEX accounting_vat_document_register_once_uq
 ON accounting_vat_register(tenant_id,vat_document_id);
COMMIT;
