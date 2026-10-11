BEGIN;

CREATE OR REPLACE FUNCTION corebiz_service_booking_charge_complete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  v_charge service_booking_charge%ROWTYPE;
BEGIN
  SELECT *
  INTO v_charge
  FROM service_booking_charge
  WHERE tenant_id=NEW.tenant_id AND id=NEW.id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_charge.status<>'CANCELLED' AND (
    v_charge.obligation_id IS NULL OR v_charge.invoice_id IS NULL
  ) THEN
    RAISE EXCEPTION 'SERVICE_BOOKING_CHARGE_LINKS_REQUIRED'
      USING ERRCODE='23514';
  END IF;

  IF v_charge.obligation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM financial_obligation o
    WHERE o.tenant_id=v_charge.tenant_id
      AND o.id=v_charge.obligation_id
      AND o.direction='RECEIVABLE'
      AND o.party_id=v_charge.payer_party_id
      AND o.source_type='SERVICE_BOOKING_CHARGE'
      AND o.source_id=v_charge.id
      AND o.currency=v_charge.currency
      AND o.amount_minor=v_charge.amount_minor
  ) THEN
    RAISE EXCEPTION 'SERVICE_BOOKING_CHARGE_OBLIGATION_MISMATCH'
      USING ERRCODE='23514';
  END IF;

  IF v_charge.invoice_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM finance_invoice i
    WHERE i.tenant_id=v_charge.tenant_id
      AND i.id=v_charge.invoice_id
      AND i.party_id=v_charge.payer_party_id
      AND i.source_type='SERVICE_BOOKING_CHARGE'
      AND i.source_id=v_charge.id
      AND i.obligation_id=v_charge.obligation_id
      AND i.currency=v_charge.currency
      AND i.amount_minor=v_charge.amount_minor
  ) THEN
    RAISE EXCEPTION 'SERVICE_BOOKING_CHARGE_INVOICE_MISMATCH'
      USING ERRCODE='23514';
  END IF;

  RETURN NULL;
END;
$$;

COMMIT;
