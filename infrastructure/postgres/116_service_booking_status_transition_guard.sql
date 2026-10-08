-- Sprint 63: guard booking status transitions even for non-API writers.
BEGIN;
CREATE OR REPLACE FUNCTION corebiz_service_booking_status_transition_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
 IF NOT (
  (OLD.status IN ('DRAFT','CONFIRMED') AND NEW.status IN ('ARRIVED','CANCELLED','NO_SHOW'))
  OR (OLD.status='ARRIVED' AND NEW.status IN ('IN_SERVICE','CANCELLED','NO_SHOW'))
  OR (OLD.status='IN_SERVICE' AND NEW.status IN ('COMPLETED','CANCELLED'))
 ) THEN
  RAISE EXCEPTION 'Service booking status transition is not allowed: % to %',OLD.status,NEW.status
    USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER service_booking_status_transition_guard_v1
BEFORE UPDATE OF status ON service_booking
FOR EACH ROW EXECUTE FUNCTION corebiz_service_booking_status_transition_guard();
COMMIT;
