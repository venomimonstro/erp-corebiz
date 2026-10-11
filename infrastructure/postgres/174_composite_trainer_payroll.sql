BEGIN;

ALTER TABLE trainer_compensation_plan
  ADD COLUMN IF NOT EXISTS service_id uuid
    REFERENCES service_catalog_item(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dance_program_id uuid
    REFERENCES dance_program(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dance_group_id uuid
    REFERENCES dance_group(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS branch_id uuid
    REFERENCES branch(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS minimum_guarantee_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS guarantee_period text NOT NULL DEFAULT 'MONTH';

ALTER TABLE trainer_compensation_plan
  DROP CONSTRAINT IF EXISTS trainer_compensation_plan_calculation_type_check,
  DROP CONSTRAINT IF EXISTS trainer_compensation_plan_lesson_type_check,
  DROP CONSTRAINT IF EXISTS trainer_compensation_plan_minimum_guarantee_minor_ck,
  DROP CONSTRAINT IF EXISTS trainer_compensation_plan_guarantee_period_ck;

ALTER TABLE trainer_compensation_plan
  ADD CONSTRAINT trainer_compensation_plan_calculation_type_check
    CHECK (calculation_type IN (
      'FIXED','HOURLY','PERCENT','ATTENDEE','TIERED','COMPOSITE'
    )),
  ADD CONSTRAINT trainer_compensation_plan_lesson_type_check
    CHECK (
      lesson_type IS NULL OR lesson_type IN (
        'GROUP','INDIVIDUAL','TRIAL','MASTER_CLASS','OPEN_CLASS',
        'REHEARSAL','RENTAL_EVENT','SELF_PRACTICE'
      )
    ),
  ADD CONSTRAINT trainer_compensation_plan_minimum_guarantee_minor_ck
    CHECK (minimum_guarantee_minor >= 0),
  ADD CONSTRAINT trainer_compensation_plan_guarantee_period_ck
    CHECK (guarantee_period IN ('DAY','MONTH'));

CREATE TABLE trainer_compensation_component (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL
    REFERENCES trainer_compensation_plan(id) ON DELETE CASCADE,
  component_type text NOT NULL
    CHECK (component_type IN (
      'FIXED_PER_LESSON','HOURLY','PERCENT','PER_ATTENDEE',
      'TIER_BONUS','DAILY_BASE','MONTHLY_BASE'
    )),
  amount_minor bigint NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  percent_bps integer NOT NULL DEFAULT 0 CHECK (percent_bps BETWEEN 0 AND 10000),
  threshold_count integer NOT NULL DEFAULT 0
    CHECK (threshold_count BETWEEN 0 AND 100000),
  revenue_basis text NOT NULL DEFAULT 'EARNED'
    CHECK (revenue_basis IN ('LIST','BILLED','PAID','EARNED')),
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 100000),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,plan_id,component_type,priority)
);

CREATE INDEX trainer_compensation_component_plan_idx
  ON trainer_compensation_component(tenant_id,plan_id,priority);

CREATE TABLE trainer_payroll_statement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  trainer_resource_id uuid NOT NULL
    REFERENCES service_resource(id) ON DELETE RESTRICT,
  period_from date NOT NULL,
  period_to date NOT NULL,
  lesson_accrual_minor bigint NOT NULL DEFAULT 0
    CHECK (lesson_accrual_minor >= 0),
  base_minor bigint NOT NULL DEFAULT 0 CHECK (base_minor >= 0),
  guarantee_adjustment_minor bigint NOT NULL DEFAULT 0
    CHECK (guarantee_adjustment_minor >= 0),
  total_minor bigint NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'RUB',
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','FINALIZED','PAID','CANCELLED')),
  calculation_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  finalized_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from),
  UNIQUE (tenant_id,trainer_resource_id,period_from,period_to)
);

CREATE INDEX trainer_payroll_statement_period_idx
  ON trainer_payroll_statement(tenant_id,period_from,status,trainer_resource_id);

CREATE OR REPLACE FUNCTION corebiz_trainer_comp_plan_overlap_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NEW.status<>'ACTIVE' THEN
    RETURN NEW;
  END IF;

  IF NEW.dance_group_id IS NOT NULL AND NEW.dance_program_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM dance_group g
       WHERE g.tenant_id=NEW.tenant_id
         AND g.id=NEW.dance_group_id
         AND g.program_id=NEW.dance_program_id
     ) THEN
    RAISE EXCEPTION 'TRAINER_COMP_GROUP_PROGRAM_MISMATCH'
      USING ERRCODE='23514';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      NEW.tenant_id::text || '|trainer-comp|' ||
      NEW.trainer_resource_id::text || '|' ||
      coalesce(NEW.service_id::text,'*') || '|' ||
      coalesce(NEW.lesson_type,'*') || '|' ||
      coalesce(NEW.dance_program_id::text,'*') || '|' ||
      coalesce(NEW.dance_group_id::text,'*') || '|' ||
      coalesce(NEW.branch_id::text,'*') || '|' ||
      NEW.priority::text,
      0
    )
  );

  IF EXISTS(
    SELECT 1
    FROM trainer_compensation_plan p
    WHERE p.tenant_id=NEW.tenant_id
      AND p.trainer_resource_id=NEW.trainer_resource_id
      AND p.service_id IS NOT DISTINCT FROM NEW.service_id
      AND p.lesson_type IS NOT DISTINCT FROM NEW.lesson_type
      AND p.dance_program_id IS NOT DISTINCT FROM NEW.dance_program_id
      AND p.dance_group_id IS NOT DISTINCT FROM NEW.dance_group_id
      AND p.branch_id IS NOT DISTINCT FROM NEW.branch_id
      AND p.priority=NEW.priority
      AND p.status='ACTIVE'
      AND p.id<>NEW.id
      AND daterange(p.valid_from,p.valid_to,'[]')
          && daterange(NEW.valid_from,NEW.valid_to,'[]')
  ) THEN
    RAISE EXCEPTION
      'Trainer compensation rules overlap for same scope and priority'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trainer_comp_plan_overlap_guard_v1
  ON trainer_compensation_plan;
CREATE TRIGGER trainer_comp_plan_overlap_guard_v2
BEFORE INSERT OR UPDATE OF
  trainer_resource_id,service_id,lesson_type,dance_program_id,dance_group_id,
  branch_id,priority,valid_from,valid_to,status
ON trainer_compensation_plan
FOR EACH ROW
EXECUTE FUNCTION corebiz_trainer_comp_plan_overlap_guard();

ALTER TABLE trainer_compensation_component ENABLE ROW LEVEL SECURITY;
ALTER TABLE trainer_payroll_statement ENABLE ROW LEVEL SECURITY;

CREATE POLICY trainer_compensation_component_isolation
  ON trainer_compensation_component
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY trainer_payroll_statement_isolation
  ON trainer_payroll_statement
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER trainer_compensation_plan_tenant_refs_v2
BEFORE INSERT OR UPDATE ON trainer_compensation_plan
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'trainer_resource_id','service_resource',
  'service_id','service_catalog_item',
  'dance_program_id','dance_program',
  'dance_group_id','dance_group',
  'branch_id','branch'
);

CREATE TRIGGER trainer_compensation_component_tenant_refs_v1
BEFORE INSERT OR UPDATE ON trainer_compensation_component
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'plan_id','trainer_compensation_plan'
);

CREATE TRIGGER trainer_payroll_statement_tenant_refs_v1
BEFORE INSERT OR UPDATE ON trainer_payroll_statement
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'trainer_resource_id','service_resource'
);

COMMIT;
