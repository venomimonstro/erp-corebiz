-- Sprint 53c: forbid changing registered VAT documents or registering wrong tax direction.
BEGIN;
CREATE OR REPLACE FUNCTION corebiz_vat_document_state_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'VAT source document deletion forbidden' USING ERRCODE='23514';
 END IF;
 IF OLD.status='CANCELLED' THEN
  RAISE EXCEPTION 'Cancelled VAT document is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.status='APPROVED' THEN
  IF (to_jsonb(OLD)-'status') IS DISTINCT FROM (to_jsonb(NEW)-'status')
    OR NEW.status NOT IN ('APPROVED','CANCELLED')
  THEN RAISE EXCEPTION 'Approved VAT evidence immutable' USING ERRCODE='23514'; END IF;
  IF NEW.status='CANCELLED' AND EXISTS(
   SELECT 1 FROM accounting_vat_register r
   WHERE r.tenant_id=OLD.tenant_id AND r.vat_document_id=OLD.id
  ) THEN
   RAISE EXCEPTION 'Registered VAT document requires explicit correction entry'
    USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;$$;
CREATE OR REPLACE FUNCTION corebiz_validate_vat_register()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE kind text;
BEGIN
 SELECT d.document_kind INTO kind
 FROM accounting_vat_document d
 WHERE d.id=NEW.vat_document_id AND d.tenant_id=NEW.tenant_id
   AND d.legal_entity_id=NEW.legal_entity_id AND d.status='APPROVED'
   AND d.vat_amount_minor=NEW.amount_minor
 FOR UPDATE;
 IF kind IS NULL THEN
   RAISE EXCEPTION 'VAT register/document mismatch or document not approved' USING ERRCODE='23514';
 END IF;
 IF (kind='ISSUED_INVOICE' AND NEW.register_kind<>'OUTPUT_VAT')
 OR (kind='RECEIVED_INVOICE' AND NEW.register_kind<>'INPUT_VAT')
 OR (kind='CORRECTION' AND NEW.register_kind<>'CORRECTION')
 THEN
   RAISE EXCEPTION 'VAT register direction incompatible with document kind' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;$$;
DO $$
BEGIN
 IF EXISTS(
 SELECT 1 FROM accounting_vat_register r
 JOIN accounting_vat_document d ON d.id=r.vat_document_id AND d.tenant_id=r.tenant_id
 WHERE (d.document_kind='ISSUED_INVOICE' AND r.register_kind<>'OUTPUT_VAT')
    OR (d.document_kind='RECEIVED_INVOICE' AND r.register_kind<>'INPUT_VAT')
    OR (d.document_kind='CORRECTION' AND r.register_kind<>'CORRECTION')
 ) THEN
  RAISE EXCEPTION 'Existing VAT register directions must be reconciled first';
 END IF;
END;$$;
COMMIT;
