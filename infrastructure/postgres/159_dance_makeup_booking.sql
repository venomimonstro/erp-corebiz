BEGIN;

ALTER TABLE dance_lesson_participant
  ADD COLUMN IF NOT EXISTS makeup_credit_id uuid
    REFERENCES dance_makeup_credit(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS dance_participant_makeup_credit_uq
  ON dance_lesson_participant(tenant_id,makeup_credit_id)
  WHERE makeup_credit_id IS NOT NULL
    AND status <> 'CANCELLED_IN_TIME';

DROP TRIGGER IF EXISTS dance_participant_tenant_refs_v1
  ON dance_lesson_participant;
CREATE TRIGGER dance_participant_tenant_refs_v1
BEFORE INSERT OR UPDATE ON dance_lesson_participant
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'lesson_id','dance_lesson',
  'student_id','dance_student',
  'package_id','service_package',
  'makeup_credit_id','dance_makeup_credit'
);

COMMIT;
