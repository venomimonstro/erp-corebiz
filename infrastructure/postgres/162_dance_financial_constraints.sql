BEGIN;

CREATE OR REPLACE FUNCTION corebiz_validate_allocated_payment_total()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  v_payment_id uuid;
  v_tenant_id uuid;
  v_source_type text;
  v_amount bigint;
  v_allocated bigint;
BEGIN
  IF TG_TABLE_NAME='payment' THEN
    v_payment_id := NEW.id;
    v_tenant_id := NEW.tenant_id;
  ELSE
    v_payment_id := coalesce(NEW.payment_id,OLD.payment_id);
    v_tenant_id := coalesce(NEW.tenant_id,OLD.tenant_id);
  END IF;

  SELECT source_type,amount_minor
  INTO v_source_type,v_amount
  FROM payment
  WHERE tenant_id=v_tenant_id AND id=v_payment_id;

  IF NOT FOUND OR v_source_type<>'ALLOCATED_RECEIVABLES' THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(sum(amount_minor),0)
  INTO v_allocated
  FROM payment_allocation
  WHERE tenant_id=v_tenant_id AND payment_id=v_payment_id;

  IF v_allocated<>v_amount THEN
    RAISE EXCEPTION
      'Allocated payment total mismatch: payment %, allocated %',
      v_amount,v_allocated
      USING ERRCODE='23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS allocated_payment_total_payment_v1 ON payment;
CREATE CONSTRAINT TRIGGER allocated_payment_total_payment_v1
AFTER INSERT OR UPDATE OF amount_minor,source_type ON payment
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION corebiz_validate_allocated_payment_total();

DROP TRIGGER IF EXISTS allocated_payment_total_allocation_v1
  ON payment_allocation;
CREATE CONSTRAINT TRIGGER allocated_payment_total_allocation_v1
AFTER INSERT OR UPDATE OR DELETE ON payment_allocation
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION corebiz_validate_allocated_payment_total();

CREATE OR REPLACE FUNCTION corebiz_makeup_credit_state_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NEW.status='AVAILABLE' THEN
    IF NEW.reserved_participant_id IS NOT NULL
       OR NEW.used_participant_id IS NOT NULL THEN
      RAISE EXCEPTION 'Available makeup credit cannot be reserved/used'
        USING ERRCODE='23514';
    END IF;
  ELSIF NEW.status='RESERVED' THEN
    IF NEW.reserved_participant_id IS NULL
       OR NEW.used_participant_id IS NOT NULL THEN
      RAISE EXCEPTION 'Reserved makeup credit state is invalid'
        USING ERRCODE='23514';
    END IF;
  ELSIF NEW.status='USED' THEN
    IF NEW.reserved_participant_id IS NOT NULL
       OR (
         NEW.used_participant_id IS NULL
         AND NEW.used_lesson_id IS NULL
       ) THEN
      RAISE EXCEPTION 'Used makeup credit state is invalid'
        USING ERRCODE='23514';
    END IF;
  END IF;

  IF NEW.used_participant_id IS NOT NULL THEN
    NEW.used_lesson_id := (
      SELECT lesson_id
      FROM dance_lesson_participant
      WHERE tenant_id=NEW.tenant_id
        AND id=NEW.used_participant_id
    );
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
