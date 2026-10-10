BEGIN;

CREATE OR REPLACE FUNCTION corebiz_trainer_comp_plan_overlap_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NEW.status<>'ACTIVE' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      NEW.tenant_id::text || '|trainer-comp|' ||
      NEW.trainer_resource_id::text || '|' ||
      coalesce(NEW.lesson_type,'*') || '|' ||
      NEW.priority::text,
      0
    )
  );

  IF EXISTS(
    SELECT 1
    FROM trainer_compensation_plan p
    WHERE p.tenant_id=NEW.tenant_id
      AND p.trainer_resource_id=NEW.trainer_resource_id
      AND p.lesson_type IS NOT DISTINCT FROM NEW.lesson_type
      AND p.priority=NEW.priority
      AND p.status='ACTIVE'
      AND p.id<>NEW.id
      AND daterange(p.valid_from,p.valid_to,'[]')
          && daterange(NEW.valid_from,NEW.valid_to,'[]')
  ) THEN
    RAISE EXCEPTION
      'Trainer compensation rules overlap for same lesson scope and priority'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trainer_comp_plan_overlap_guard_v1
  ON trainer_compensation_plan;
CREATE TRIGGER trainer_comp_plan_overlap_guard_v1
BEFORE INSERT OR UPDATE OF
  trainer_resource_id,lesson_type,priority,valid_from,valid_to,status
ON trainer_compensation_plan
FOR EACH ROW
EXECUTE FUNCTION corebiz_trainer_comp_plan_overlap_guard();

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

  IF EXISTS(
    SELECT 1
    FROM service_package_plan_entitlement e
    WHERE e.tenant_id=NEW.tenant_id
      AND e.plan_id=NEW.plan_id
      AND e.lesson_type IS NOT DISTINCT FROM NEW.lesson_type
      AND e.dance_program_id IS NOT DISTINCT FROM NEW.dance_program_id
      AND e.dance_group_id IS NOT DISTINCT FROM NEW.dance_group_id
      AND e.priority=NEW.priority
      AND e.id<>NEW.id
  ) THEN
    RAISE EXCEPTION
      'Duplicate package entitlement scope and priority'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS package_plan_entitlement_guard_v1
  ON service_package_plan_entitlement;
CREATE TRIGGER package_plan_entitlement_guard_v1
BEFORE INSERT OR UPDATE ON service_package_plan_entitlement
FOR EACH ROW
EXECUTE FUNCTION corebiz_package_plan_entitlement_guard();

COMMIT;
