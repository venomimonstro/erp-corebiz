BEGIN;

-- A group is the serialization boundary for enrolment, waitlist promotion,
-- changes to capacity, and reactivation after a student's pause.
CREATE OR REPLACE FUNCTION corebiz_guard_dance_group_seats()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE allowed integer;
DECLARE occupied integer;
BEGIN
  IF NOT (NEW.reserved_place AND NEW.status IN ('ACTIVE','TRIAL','PAUSED'))
     THEN RETURN NEW; END IF;

  SELECT capacity INTO allowed FROM dance_group
  WHERE tenant_id=NEW.tenant_id AND id=NEW.group_id FOR UPDATE;
  IF allowed IS NULL THEN
    RAISE EXCEPTION 'Dance group not found' USING ERRCODE='23503';
  END IF;

  -- PostgreSQL executes BEFORE INSERT even when INSERT ... ON CONFLICT
  -- ultimately updates an already enrolled student.
  IF TG_OP='INSERT' AND EXISTS (
    SELECT 1 FROM dance_group_member
    WHERE tenant_id=NEW.tenant_id AND group_id=NEW.group_id
      AND student_id=NEW.student_id
      AND reserved_place AND status IN ('ACTIVE','TRIAL','PAUSED')
  ) THEN RETURN NEW; END IF;

  SELECT count(*)::integer INTO occupied FROM dance_group_member m
  WHERE m.tenant_id=NEW.tenant_id AND m.group_id=NEW.group_id
    AND m.reserved_place AND m.status IN ('ACTIVE','TRIAL','PAUSED')
    AND m.id<>NEW.id;
  IF occupied>=allowed THEN
    RAISE EXCEPTION 'Dance group has no available seats'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;$$;

CREATE TRIGGER dance_group_member_seat_guard
BEFORE INSERT OR UPDATE OF group_id,status,reserved_place
ON dance_group_member FOR EACH ROW
EXECUTE FUNCTION corebiz_guard_dance_group_seats();

CREATE OR REPLACE FUNCTION corebiz_guard_dance_lesson_seats()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE allowed integer;
DECLARE occupied integer;
BEGIN
  IF NEW.status IN ('WAITLIST','CANCELLED_IN_TIME') THEN RETURN NEW; END IF;
  SELECT capacity INTO allowed FROM dance_lesson
  WHERE tenant_id=NEW.tenant_id AND id=NEW.lesson_id FOR UPDATE;
  IF allowed IS NULL THEN
    RAISE EXCEPTION 'Dance lesson not found' USING ERRCODE='23503';
  END IF;
  IF TG_OP='INSERT' AND EXISTS (
    SELECT 1 FROM dance_lesson_participant
    WHERE tenant_id=NEW.tenant_id AND lesson_id=NEW.lesson_id
      AND student_id=NEW.student_id
      AND status NOT IN ('WAITLIST','CANCELLED_IN_TIME')
  ) THEN RETURN NEW; END IF;
  SELECT count(*)::integer INTO occupied FROM dance_lesson_participant lp
  WHERE lp.tenant_id=NEW.tenant_id AND lp.lesson_id=NEW.lesson_id
    AND lp.id<>NEW.id AND lp.status NOT IN ('WAITLIST','CANCELLED_IN_TIME');
  IF occupied>=allowed THEN
    RAISE EXCEPTION 'Dance lesson is full; use waiting list'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;$$;

CREATE TRIGGER dance_lesson_participant_seat_guard
BEFORE INSERT OR UPDATE OF lesson_id,status
ON dance_lesson_participant FOR EACH ROW
EXECUTE FUNCTION corebiz_guard_dance_lesson_seats();

-- Imports or direct SQL edits must not reduce capacity below actual bookings.
CREATE OR REPLACE FUNCTION corebiz_guard_dance_capacity_reduction()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE occupied integer;
BEGIN
  IF NEW.capacity>=OLD.capacity THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='dance_group' THEN
    SELECT count(*)::integer INTO occupied FROM dance_group_member m
    WHERE m.tenant_id=NEW.tenant_id AND m.group_id=NEW.id
      AND m.reserved_place AND m.status IN ('ACTIVE','TRIAL','PAUSED');
  ELSE
    SELECT count(*)::integer INTO occupied FROM dance_lesson_participant lp
    WHERE lp.tenant_id=NEW.tenant_id AND lp.lesson_id=NEW.id
      AND lp.status NOT IN ('WAITLIST','CANCELLED_IN_TIME');
  END IF;
  IF occupied>NEW.capacity THEN
    RAISE EXCEPTION 'Cannot reduce dance capacity below occupied places'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;$$;

CREATE TRIGGER dance_group_capacity_guard
BEFORE UPDATE OF capacity ON dance_group FOR EACH ROW
EXECUTE FUNCTION corebiz_guard_dance_capacity_reduction();

CREATE TRIGGER dance_lesson_capacity_guard
BEFORE UPDATE OF capacity ON dance_lesson FOR EACH ROW
EXECUTE FUNCTION corebiz_guard_dance_capacity_reduction();

COMMIT;
