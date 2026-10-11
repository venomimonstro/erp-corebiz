BEGIN;

CREATE OR REPLACE FUNCTION corebiz_package_plan_entitlement_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  v_group_program uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      NEW.tenant_id::text || '|package-entitlement|' || NEW.plan_id::text,
      0
    )
  );

  IF NEW.dance_group_id IS NOT NULL
     AND NEW.dance_program_id IS NOT NULL THEN
    SELECT program_id
    INTO v_group_program
    FROM dance_group
    WHERE tenant_id=NEW.tenant_id
      AND id=NEW.dance_group_id;

    IF v_group_program IS DISTINCT FROM NEW.dance_program_id THEN
      RAISE EXCEPTION
        'Package entitlement group belongs to another dance program'
        USING ERRCODE='23514';
    END IF;
  END IF;

  IF NEW.trainer_resource_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM service_resource r
    WHERE r.tenant_id=NEW.tenant_id
      AND r.id=NEW.trainer_resource_id
      AND r.type='EMPLOYEE'
      AND r.status='ACTIVE'
  ) THEN
    RAISE EXCEPTION
      'Package entitlement trainer is invalid'
      USING ERRCODE='23514';
  END IF;

  IF EXISTS(
    SELECT 1
    FROM service_package_plan_entitlement e
    WHERE e.tenant_id=NEW.tenant_id
      AND e.plan_id=NEW.plan_id
      AND e.service_id IS NOT DISTINCT FROM NEW.service_id
      AND e.trainer_resource_id IS NOT DISTINCT FROM NEW.trainer_resource_id
      AND e.lesson_type IS NOT DISTINCT FROM NEW.lesson_type
      AND e.dance_program_id IS NOT DISTINCT FROM NEW.dance_program_id
      AND e.dance_group_id IS NOT DISTINCT FROM NEW.dance_group_id
      AND e.priority=NEW.priority
      AND e.id<>NEW.id
      AND e.weekdays && NEW.weekdays
      AND int4range(e.start_minute::int,e.end_minute::int,'[)')
          && int4range(NEW.start_minute::int,NEW.end_minute::int,'[)')
  ) THEN
    RAISE EXCEPTION
      'Duplicate or overlapping package entitlement scope and priority'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS package_plan_entitlement_guard_v1
  ON service_package_plan_entitlement;
CREATE TRIGGER package_plan_entitlement_guard_v2
BEFORE INSERT OR UPDATE ON service_package_plan_entitlement
FOR EACH ROW
EXECUTE FUNCTION corebiz_package_plan_entitlement_guard();

COMMIT;
