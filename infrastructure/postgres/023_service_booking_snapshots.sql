BEGIN;

ALTER TABLE service_catalog_skill_requirement
  ADD COLUMN resource_type text NOT NULL DEFAULT 'EMPLOYEE'
  CHECK (resource_type IN (
    'EMPLOYEE','ROOM','EQUIPMENT','VEHICLE','WORKPLACE','HALL','MACHINE','OTHER'
  ));

ALTER TABLE service_booking
  ADD COLUMN duration_minutes_snapshot integer NOT NULL DEFAULT 60
    CHECK (duration_minutes_snapshot BETWEEN 5 AND 1440),
  ADD COLUMN buffer_before_minutes_snapshot integer NOT NULL DEFAULT 0
    CHECK (buffer_before_minutes_snapshot BETWEEN 0 AND 240),
  ADD COLUMN buffer_after_minutes_snapshot integer NOT NULL DEFAULT 0
    CHECK (buffer_after_minutes_snapshot BETWEEN 0 AND 240);

COMMIT;
