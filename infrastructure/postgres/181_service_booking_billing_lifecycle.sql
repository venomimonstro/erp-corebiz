BEGIN;

CREATE OR REPLACE FUNCTION corebiz_validate_finance_invoice()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM financial_obligation o
    WHERE o.id=NEW.obligation_id
      AND o.tenant_id=NEW.tenant_id
      AND o.direction='RECEIVABLE'
      AND o.party_id=NEW.party_id
      AND o.source_type=NEW.source_type
      AND o.source_id=NEW.source_id
      AND o.currency=NEW.currency
      AND o.amount_minor=NEW.amount_minor
  ) THEN
    RAISE EXCEPTION 'Invoice obligation snapshot mismatch'
      USING ERRCODE='23514';
  END IF;

  IF NEW.source_type='WMS_3PL_STATEMENT' AND NOT EXISTS (
    SELECT 1
    FROM wms_3pl_statement s
    JOIN inventory_owner io
      ON io.tenant_id=s.tenant_id AND io.id=s.owner_id
    WHERE s.id=NEW.source_id
      AND s.tenant_id=NEW.tenant_id
      AND s.status='FINALIZED'
      AND io.owner_type='CLIENT'
      AND io.party_id=NEW.party_id
      AND s.currency=NEW.currency
      AND s.total_minor=NEW.amount_minor
      AND s.period_from IS NOT DISTINCT FROM NEW.period_from
      AND s.period_to IS NOT DISTINCT FROM NEW.period_to
  ) THEN
    RAISE EXCEPTION 'Invoice 3PL statement snapshot mismatch'
      USING ERRCODE='23514';
  END IF;

  IF NEW.source_type='DANCE_STUDENT_CHARGE' AND NOT EXISTS (
    SELECT 1 FROM dance_student_charge c
    WHERE c.id=NEW.source_id
      AND c.tenant_id=NEW.tenant_id
      AND c.payer_party_id=NEW.party_id
      AND c.currency=NEW.currency
      AND c.amount_minor=NEW.amount_minor
  ) THEN
    RAISE EXCEPTION 'Invoice dance charge snapshot mismatch'
      USING ERRCODE='23514';
  END IF;

  IF NEW.source_type='SERVICE_BOOKING_CHARGE' AND NOT EXISTS (
    SELECT 1 FROM service_booking_charge c
    WHERE c.id=NEW.source_id
      AND c.tenant_id=NEW.tenant_id
      AND c.payer_party_id=NEW.party_id
      AND c.currency=NEW.currency
      AND c.amount_minor=NEW.amount_minor
  ) THEN
    RAISE EXCEPTION 'Invoice service booking charge snapshot mismatch'
      USING ERRCODE='23514';
  END IF;

  IF TG_OP='UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
    NEW.business_number IS DISTINCT FROM OLD.business_number OR
    NEW.party_id IS DISTINCT FROM OLD.party_id OR
    NEW.source_type IS DISTINCT FROM OLD.source_type OR
    NEW.source_id IS DISTINCT FROM OLD.source_id OR
    NEW.obligation_id IS DISTINCT FROM OLD.obligation_id OR
    NEW.period_from IS DISTINCT FROM OLD.period_from OR
    NEW.period_to IS DISTINCT FROM OLD.period_to OR
    NEW.currency IS DISTINCT FROM OLD.currency OR
    NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
  ) THEN
    RAISE EXCEPTION 'Issued invoice snapshot fields are immutable'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS service_booking_charge_obligation_uq
  ON service_booking_charge(obligation_id)
  WHERE obligation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS service_booking_charge_invoice_uq
  ON service_booking_charge(invoice_id)
  WHERE invoice_id IS NOT NULL;

COMMIT;
