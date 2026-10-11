BEGIN;

ALTER TABLE accounting_compliance_packet
  ADD COLUMN IF NOT EXISTS signature_reference text,
  ADD COLUMN IF NOT EXISTS certificate_fingerprint_snapshot text;

CREATE OR REPLACE FUNCTION corebiz_accounting_compliance_packet_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1
    FROM accounting_compliance_obligation o
    WHERE o.tenant_id=NEW.tenant_id
      AND o.id=NEW.obligation_id
      AND o.legal_entity_id=NEW.legal_entity_id
  ) THEN
    RAISE EXCEPTION 'ACCOUNTING_COMPLIANCE_PACKET_OBLIGATION_MISMATCH'
      USING ERRCODE='23514';
  END IF;

  IF NEW.signature_status='SIGNED'
     AND (
       NEW.signed_at IS NULL
       OR NEW.signed_by_membership_id IS NULL
       OR nullif(btrim(NEW.signature_reference),'') IS NULL
       OR nullif(btrim(NEW.certificate_fingerprint_snapshot),'') IS NULL
     ) THEN
    RAISE EXCEPTION 'ACCOUNTING_COMPLIANCE_PACKET_SIGNATURE_EVIDENCE_REQUIRED'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounting_compliance_packet_guard_v1
  ON accounting_compliance_packet;
CREATE TRIGGER accounting_compliance_packet_guard_v2
BEFORE INSERT OR UPDATE
ON accounting_compliance_packet
FOR EACH ROW
EXECUTE FUNCTION corebiz_accounting_compliance_packet_guard();

COMMIT;
