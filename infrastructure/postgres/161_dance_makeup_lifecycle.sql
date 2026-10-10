BEGIN;

ALTER TABLE dance_makeup_credit
  ADD COLUMN IF NOT EXISTS dance_program_id uuid
    REFERENCES dance_program(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dance_group_id uuid
    REFERENCES dance_group(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reserved_participant_id uuid
    REFERENCES dance_lesson_participant(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS used_participant_id uuid
    REFERENCES dance_lesson_participant(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS dance_makeup_credit_available_idx
  ON dance_makeup_credit(
    tenant_id,student_id,status,expires_at,dance_program_id,dance_group_id
  );

DROP TRIGGER IF EXISTS dance_makeup_tenant_refs_v1 ON dance_makeup_credit;
CREATE TRIGGER dance_makeup_tenant_refs_v1
BEFORE INSERT OR UPDATE ON dance_makeup_credit
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'student_id','dance_student',
  'source_lesson_id','dance_lesson',
  'source_participant_id','dance_lesson_participant',
  'used_lesson_id','dance_lesson',
  'dance_program_id','dance_program',
  'dance_group_id','dance_group',
  'reserved_participant_id','dance_lesson_participant',
  'used_participant_id','dance_lesson_participant'
);

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
       OR NEW.used_participant_id IS NULL THEN
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

DROP TRIGGER IF EXISTS dance_makeup_credit_state_guard_v1
  ON dance_makeup_credit;
CREATE TRIGGER dance_makeup_credit_state_guard_v1
BEFORE INSERT OR UPDATE ON dance_makeup_credit
FOR EACH ROW EXECUTE FUNCTION corebiz_makeup_credit_state_guard();

COMMIT;
