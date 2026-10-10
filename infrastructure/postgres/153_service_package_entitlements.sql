BEGIN;

ALTER TABLE dance_program
  ADD COLUMN IF NOT EXISTS service_id uuid
    REFERENCES service_catalog_item(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS dance_program_service_idx
  ON dance_program(tenant_id,service_id,status);

ALTER TABLE service_package_plan
  ADD COLUMN IF NOT EXISTS package_kind text NOT NULL DEFAULT 'VISITS',
  ADD COLUMN IF NOT EXISTS dance_program_id uuid
    REFERENCES dance_program(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dance_group_id uuid
    REFERENCES dance_group(id) ON DELETE SET NULL;

ALTER TABLE service_package_plan
  DROP CONSTRAINT IF EXISTS service_package_plan_visit_limit_check;

ALTER TABLE service_package_plan
  ALTER COLUMN visit_limit DROP NOT NULL;

ALTER TABLE service_package_plan
  ADD CONSTRAINT service_package_plan_package_kind_ck
  CHECK (package_kind IN (
    'VISITS','PERIOD','UNLIMITED','FAMILY','INDIVIDUAL',
    'COMBO','TRIAL','GIFT'
  )),
  ADD CONSTRAINT service_package_plan_visit_limit_v2_ck
  CHECK (
    (package_kind='UNLIMITED' AND visit_limit IS NULL)
    OR
    (package_kind<>'UNLIMITED' AND visit_limit BETWEEN 1 AND 10000)
  );

ALTER TABLE service_package
  ADD COLUMN IF NOT EXISTS package_kind_snapshot text NOT NULL DEFAULT 'VISITS',
  ADD COLUMN IF NOT EXISTS dance_program_id_snapshot uuid
    REFERENCES dance_program(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dance_group_id_snapshot uuid
    REFERENCES dance_group(id) ON DELETE SET NULL;

ALTER TABLE service_package
  ALTER COLUMN visit_limit_snapshot DROP NOT NULL;

ALTER TABLE service_package
  ADD CONSTRAINT service_package_kind_snapshot_ck
  CHECK (package_kind_snapshot IN (
    'VISITS','PERIOD','UNLIMITED','FAMILY','INDIVIDUAL',
    'COMBO','TRIAL','GIFT'
  )),
  ADD CONSTRAINT service_package_visit_limit_v2_ck
  CHECK (
    (package_kind_snapshot='UNLIMITED' AND visit_limit_snapshot IS NULL)
    OR
    (package_kind_snapshot<>'UNLIMITED' AND visit_limit_snapshot > 0)
  );

COMMIT;
