BEGIN;

CREATE TABLE trainer_payroll_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  trainer_resource_id uuid NOT NULL REFERENCES service_resource(id) ON DELETE CASCADE,
  monthly_base_minor bigint NOT NULL DEFAULT 0 CHECK (monthly_base_minor >= 0),
  daily_base_minor bigint NOT NULL DEFAULT 0 CHECK (daily_base_minor >= 0),
  minimum_guarantee_minor bigint NOT NULL DEFAULT 0 CHECK (minimum_guarantee_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'RUB',
  valid_from date NOT NULL DEFAULT current_date,
  valid_to date,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  note text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  UNIQUE (tenant_id,id)
);

CREATE INDEX trainer_payroll_profile_match_idx
  ON trainer_payroll_profile(
    tenant_id,trainer_resource_id,status,valid_from,valid_to
  );

CREATE OR REPLACE FUNCTION corebiz_trainer_payroll_profile_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NEW.status <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM service_resource r
    WHERE r.tenant_id=NEW.tenant_id
      AND r.id=NEW.trainer_resource_id
      AND r.type='EMPLOYEE'
      AND r.status='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'TRAINER_PAYROLL_PROFILE_EMPLOYEE_INVALID'
      USING ERRCODE='23514';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      NEW.tenant_id::text || '|trainer-payroll-profile|' ||
      NEW.trainer_resource_id::text,
      0
    )
  );

  IF EXISTS (
    SELECT 1
    FROM trainer_payroll_profile p
    WHERE p.tenant_id=NEW.tenant_id
      AND p.trainer_resource_id=NEW.trainer_resource_id
      AND p.id<>NEW.id
      AND p.status='ACTIVE'
      AND daterange(p.valid_from,p.valid_to,'[]')
          && daterange(NEW.valid_from,NEW.valid_to,'[]')
  ) THEN
    RAISE EXCEPTION 'TRAINER_PAYROLL_PROFILE_OVERLAP'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trainer_payroll_profile_guard_v1
BEFORE INSERT OR UPDATE OF
  trainer_resource_id,valid_from,valid_to,status
ON trainer_payroll_profile
FOR EACH ROW
EXECUTE FUNCTION corebiz_trainer_payroll_profile_guard();

ALTER TABLE trainer_payroll_profile ENABLE ROW LEVEL SECURITY;

CREATE POLICY trainer_payroll_profile_isolation
  ON trainer_payroll_profile
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE TRIGGER trainer_payroll_profile_tenant_refs_v1
BEFORE INSERT OR UPDATE ON trainer_payroll_profile
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'trainer_resource_id','service_resource'
);

COMMIT;
