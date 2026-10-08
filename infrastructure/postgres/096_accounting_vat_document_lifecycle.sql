-- Sprint 53b: VAT approval/revocation state integrity.
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
CREATE TRIGGER vat_document_state_guard_v1
 BEFORE UPDATE OR DELETE ON accounting_vat_document
 FOR EACH ROW EXECUTE FUNCTION corebiz_vat_document_state_guard();
COMMIT;
