BEGIN;

ALTER TABLE dance_lesson
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Europe/Moscow';

UPDATE dance_lesson l
SET timezone=coalesce(
  (
    SELECT rr.timezone
    FROM service_resource rr
    WHERE rr.tenant_id=l.tenant_id
      AND rr.id=l.room_resource_id
  ),
  (
    SELECT tr.timezone
    FROM service_resource tr
    WHERE tr.tenant_id=l.tenant_id
      AND tr.id=l.trainer_resource_id
  ),
  'Europe/Moscow'
)
WHERE l.timezone IS NULL
   OR l.timezone=''
   OR l.timezone='Europe/Moscow';

CREATE OR REPLACE FUNCTION corebiz_valid_timezone(value text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path=public,pg_temp
AS $$
  SELECT EXISTS(
    SELECT 1
    FROM pg_timezone_names
    WHERE name=value
  );
$$;

ALTER TABLE dance_lesson
  DROP CONSTRAINT IF EXISTS dance_lesson_timezone_ck;

ALTER TABLE dance_lesson
  ADD CONSTRAINT dance_lesson_timezone_ck
  CHECK (corebiz_valid_timezone(timezone));

COMMIT;
