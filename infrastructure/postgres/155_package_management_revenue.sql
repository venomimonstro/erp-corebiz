BEGIN;

ALTER TABLE service_package_plan
  ADD COLUMN IF NOT EXISTS management_visit_value_minor bigint NOT NULL DEFAULT 0
    CHECK (management_visit_value_minor >= 0);

COMMIT;
