BEGIN;

ALTER TABLE service_package_plan_entitlement
  ADD COLUMN IF NOT EXISTS service_id uuid
    REFERENCES service_catalog_item(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS trainer_resource_id uuid
    REFERENCES service_resource(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS weekdays smallint[] NOT NULL
    DEFAULT ARRAY[1,2,3,4,5,6,7]::smallint[],
  ADD COLUMN IF NOT EXISTS start_minute smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS end_minute smallint NOT NULL DEFAULT 1440;

ALTER TABLE service_package_plan_entitlement
  DROP CONSTRAINT IF EXISTS service_package_plan_entitlement_lesson_type_check,
  DROP CONSTRAINT IF EXISTS service_package_plan_entitlement_weekdays_ck,
  DROP CONSTRAINT IF EXISTS service_package_plan_entitlement_time_ck;

ALTER TABLE service_package_plan_entitlement
  ADD CONSTRAINT service_package_plan_entitlement_lesson_type_check
    CHECK (
      lesson_type IS NULL OR lesson_type IN (
        'GROUP','INDIVIDUAL','TRIAL','MASTER_CLASS','OPEN_CLASS',
        'REHEARSAL','RENTAL_EVENT','SELF_PRACTICE'
      )
    ),
  ADD CONSTRAINT service_package_plan_entitlement_weekdays_ck
    CHECK (corebiz_valid_weekdays(weekdays)),
  ADD CONSTRAINT service_package_plan_entitlement_time_ck
    CHECK (
      start_minute BETWEEN 0 AND 1439
      AND end_minute BETWEEN 1 AND 1440
      AND end_minute > start_minute
    );

ALTER TABLE service_package_entitlement
  ADD COLUMN IF NOT EXISTS service_id uuid
    REFERENCES service_catalog_item(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS trainer_resource_id uuid
    REFERENCES service_resource(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS weekdays smallint[] NOT NULL
    DEFAULT ARRAY[1,2,3,4,5,6,7]::smallint[],
  ADD COLUMN IF NOT EXISTS start_minute smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS end_minute smallint NOT NULL DEFAULT 1440;

ALTER TABLE service_package_entitlement
  DROP CONSTRAINT IF EXISTS service_package_entitlement_lesson_type_check,
  DROP CONSTRAINT IF EXISTS service_package_entitlement_weekdays_ck,
  DROP CONSTRAINT IF EXISTS service_package_entitlement_time_ck;

ALTER TABLE service_package_entitlement
  ADD CONSTRAINT service_package_entitlement_lesson_type_check
    CHECK (
      lesson_type IS NULL OR lesson_type IN (
        'GROUP','INDIVIDUAL','TRIAL','MASTER_CLASS','OPEN_CLASS',
        'REHEARSAL','RENTAL_EVENT','SELF_PRACTICE'
      )
    ),
  ADD CONSTRAINT service_package_entitlement_weekdays_ck
    CHECK (corebiz_valid_weekdays(weekdays)),
  ADD CONSTRAINT service_package_entitlement_time_ck
    CHECK (
      start_minute BETWEEN 0 AND 1439
      AND end_minute BETWEEN 1 AND 1440
      AND end_minute > start_minute
    );

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid='service_package_plan_entitlement'::regclass
      AND contype='u'
  LOOP
    EXECUTE format(
      'ALTER TABLE service_package_plan_entitlement DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END;
$$;

CREATE UNIQUE INDEX service_package_plan_entitlement_scope_uq
  ON service_package_plan_entitlement(
    tenant_id,
    plan_id,
    coalesce(service_id,'00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(trainer_resource_id,'00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(lesson_type,''),
    coalesce(dance_program_id,'00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(dance_group_id,'00000000-0000-0000-0000-000000000000'::uuid),
    weekdays,
    start_minute,
    end_minute,
    priority
  );

DROP INDEX IF EXISTS service_package_plan_entitlement_match_idx;
CREATE INDEX service_package_plan_entitlement_match_idx
  ON service_package_plan_entitlement(
    tenant_id,plan_id,priority,service_id,trainer_resource_id,
    lesson_type,dance_program_id,dance_group_id
  );

DROP INDEX IF EXISTS service_package_entitlement_match_idx;
CREATE INDEX service_package_entitlement_match_idx
  ON service_package_entitlement(
    tenant_id,package_id,priority,service_id,trainer_resource_id,
    lesson_type,dance_program_id,dance_group_id
  );

CREATE OR REPLACE FUNCTION corebiz_package_entitlement_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NEW.trainer_resource_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM service_resource r
    WHERE r.tenant_id=NEW.tenant_id
      AND r.id=NEW.trainer_resource_id
      AND r.type='EMPLOYEE'
  ) THEN
    RAISE EXCEPTION 'PACKAGE_ENTITLEMENT_TRAINER_INVALID';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_package_plan_entitlement_scope_guard_v1
  ON service_package_plan_entitlement;
CREATE TRIGGER service_package_plan_entitlement_scope_guard_v1
BEFORE INSERT OR UPDATE OF service_id,trainer_resource_id
ON service_package_plan_entitlement
FOR EACH ROW EXECUTE FUNCTION corebiz_package_entitlement_scope_guard();

DROP TRIGGER IF EXISTS service_package_entitlement_scope_guard_v1
  ON service_package_entitlement;
CREATE TRIGGER service_package_entitlement_scope_guard_v1
BEFORE INSERT OR UPDATE OF service_id,trainer_resource_id
ON service_package_entitlement
FOR EACH ROW EXECUTE FUNCTION corebiz_package_entitlement_scope_guard();

CREATE TRIGGER service_package_plan_entitlement_tenant_refs_v2
BEFORE INSERT OR UPDATE ON service_package_plan_entitlement
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'plan_id','service_package_plan',
  'service_id','service_catalog_item',
  'trainer_resource_id','service_resource',
  'dance_program_id','dance_program',
  'dance_group_id','dance_group'
);

CREATE TRIGGER service_package_entitlement_tenant_refs_v2
BEFORE INSERT OR UPDATE ON service_package_entitlement
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'package_id','service_package',
  'service_id','service_catalog_item',
  'trainer_resource_id','service_resource',
  'dance_program_id','dance_program',
  'dance_group_id','dance_group'
);

COMMIT;
