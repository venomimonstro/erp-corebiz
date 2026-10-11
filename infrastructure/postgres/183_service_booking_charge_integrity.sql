BEGIN;

CREATE OR REPLACE FUNCTION corebiz_service_booking_charge_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  v_party_id uuid;
  v_currency char(3);
  v_price_minor bigint;
BEGIN
  SELECT party_id,currency,price_minor_snapshot
  INTO v_party_id,v_currency,v_price_minor
  FROM service_booking
  WHERE tenant_id=NEW.tenant_id AND id=NEW.booking_id
  FOR SHARE;

  IF v_party_id IS NULL THEN
    RAISE EXCEPTION 'SERVICE_BOOKING_CHARGE_REQUIRES_PARTY'
      USING ERRCODE='23514';
  END IF;

  IF NEW.payer_party_id IS DISTINCT FROM v_party_id THEN
    RAISE EXCEPTION 'SERVICE_BOOKING_CHARGE_PAYER_MISMATCH'
      USING ERRCODE='23514';
  END IF;

  IF NEW.currency IS DISTINCT FROM v_currency
     OR NEW.amount_minor IS DISTINCT FROM v_price_minor THEN
    RAISE EXCEPTION 'SERVICE_BOOKING_CHARGE_SNAPSHOT_MISMATCH'
      USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM service_package_redemption r
    WHERE r.tenant_id=NEW.tenant_id
      AND r.booking_id=NEW.booking_id
      AND r.state IN ('RESERVED','CONSUMED')
  ) THEN
    RAISE EXCEPTION 'SERVICE_BOOKING_CHARGE_PACKAGE_CONFLICT'
      USING ERRCODE='23514';
  END IF;

  IF TG_OP='UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
    NEW.booking_id IS DISTINCT FROM OLD.booking_id OR
    NEW.payer_party_id IS DISTINCT FROM OLD.payer_party_id OR
    NEW.currency IS DISTINCT FROM OLD.currency OR
    NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR
    NEW.created_by_membership_id IS DISTINCT FROM OLD.created_by_membership_id
  ) THEN
    RAISE EXCEPTION 'SERVICE_BOOKING_CHARGE_SNAPSHOT_IMMUTABLE'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_booking_charge_guard_v1
  ON service_booking_charge;
CREATE TRIGGER service_booking_charge_guard_v1
BEFORE INSERT OR UPDATE ON service_booking_charge
FOR EACH ROW EXECUTE FUNCTION corebiz_service_booking_charge_guard();

CREATE OR REPLACE FUNCTION corebiz_service_booking_charge_complete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NEW.status<>'CANCELLED' AND (
    NEW.obligation_id IS NULL OR NEW.invoice_id IS NULL
  ) THEN
    RAISE EXCEPTION 'SERVICE_BOOKING_CHARGE_LINKS_REQUIRED'
      USING ERRCODE='23514';
  END IF;

  IF NEW.obligation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM financial_obligation o
    WHERE o.tenant_id=NEW.tenant_id
      AND o.id=NEW.obligation_id
      AND o.direction='RECEIVABLE'
      AND o.party_id=NEW.payer_party_id
      AND o.source_type='SERVICE_BOOKING_CHARGE'
      AND o.source_id=NEW.id
      AND o.currency=NEW.currency
      AND o.amount_minor=NEW.amount_minor
  ) THEN
    RAISE EXCEPTION 'SERVICE_BOOKING_CHARGE_OBLIGATION_MISMATCH'
      USING ERRCODE='23514';
  END IF;

  IF NEW.invoice_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM finance_invoice i
    WHERE i.tenant_id=NEW.tenant_id
      AND i.id=NEW.invoice_id
      AND i.party_id=NEW.payer_party_id
      AND i.source_type='SERVICE_BOOKING_CHARGE'
      AND i.source_id=NEW.id
      AND i.obligation_id=NEW.obligation_id
      AND i.currency=NEW.currency
      AND i.amount_minor=NEW.amount_minor
  ) THEN
    RAISE EXCEPTION 'SERVICE_BOOKING_CHARGE_INVOICE_MISMATCH'
      USING ERRCODE='23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS service_booking_charge_complete_v1
  ON service_booking_charge;
CREATE CONSTRAINT TRIGGER service_booking_charge_complete_v1
AFTER INSERT OR UPDATE ON service_booking_charge
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION corebiz_service_booking_charge_complete();

COMMIT;
