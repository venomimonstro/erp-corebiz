BEGIN;

CREATE TABLE service_employee_compensation_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  employee_resource_id uuid NOT NULL REFERENCES service_resource(id) ON DELETE CASCADE,
  service_id uuid REFERENCES service_catalog_item(id) ON DELETE CASCADE,
  delivery_format text
    CHECK (
      delivery_format IS NULL OR
      delivery_format IN ('INDIVIDUAL','GROUP','SELF_PRACTICE','RENTAL')
    ),
  branch_id uuid REFERENCES branch(id) ON DELETE CASCADE,
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 100000),
  currency char(3) NOT NULL DEFAULT 'RUB',
  valid_from date NOT NULL DEFAULT current_date,
  valid_to date,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  UNIQUE (tenant_id,id)
);

CREATE INDEX service_employee_compensation_plan_match_idx
  ON service_employee_compensation_plan(
    tenant_id,employee_resource_id,status,service_id,delivery_format,
    branch_id,priority,valid_from,valid_to
  );

CREATE TABLE service_employee_compensation_component (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL
    REFERENCES service_employee_compensation_plan(id) ON DELETE CASCADE,
  component_type text NOT NULL
    CHECK (component_type IN (
      'FIXED_VISIT','HOURLY','PERCENT_REVENUE','PERCENT_MARGIN'
    )),
  amount_minor bigint NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  percent_bps integer NOT NULL DEFAULT 0 CHECK (percent_bps BETWEEN 0 AND 10000),
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 100000),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,plan_id,component_type,priority)
);

CREATE TABLE service_employee_payroll_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  employee_resource_id uuid NOT NULL REFERENCES service_resource(id) ON DELETE CASCADE,
  monthly_base_minor bigint NOT NULL DEFAULT 0 CHECK (monthly_base_minor >= 0),
  daily_base_minor bigint NOT NULL DEFAULT 0 CHECK (daily_base_minor >= 0),
  minimum_guarantee_minor bigint NOT NULL DEFAULT 0
    CHECK (minimum_guarantee_minor >= 0),
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

CREATE INDEX service_employee_payroll_profile_match_idx
  ON service_employee_payroll_profile(
    tenant_id,employee_resource_id,status,valid_from,valid_to
  );

CREATE TABLE service_booking_profitability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES service_booking(id) ON DELETE RESTRICT,
  employee_resource_id uuid REFERENCES service_resource(id) ON DELETE SET NULL,
  revenue_minor bigint NOT NULL DEFAULT 0 CHECK (revenue_minor >= 0),
  material_cost_minor bigint NOT NULL DEFAULT 0 CHECK (material_cost_minor >= 0),
  employee_cost_minor bigint NOT NULL DEFAULT 0 CHECK (employee_cost_minor >= 0),
  resource_cost_minor bigint NOT NULL DEFAULT 0 CHECK (resource_cost_minor >= 0),
  other_cost_minor bigint NOT NULL DEFAULT 0 CHECK (other_cost_minor >= 0),
  contribution_margin_minor bigint NOT NULL,
  currency char(3) NOT NULL DEFAULT 'RUB',
  calculation_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,booking_id)
);

CREATE INDEX service_booking_profitability_employee_idx
  ON service_booking_profitability(
    tenant_id,employee_resource_id,calculated_at
  );

CREATE TABLE service_employee_booking_accrual (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES service_booking(id) ON DELETE RESTRICT,
  employee_resource_id uuid NOT NULL REFERENCES service_resource(id) ON DELETE RESTRICT,
  plan_id uuid REFERENCES service_employee_compensation_plan(id) ON DELETE SET NULL,
  amount_minor bigint NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'RUB',
  rule_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'CALCULATED'
    CHECK (status IN ('CALCULATED','APPROVED','EXPORTED','REVERSED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  approved_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  UNIQUE (tenant_id,booking_id,employee_resource_id)
);

CREATE INDEX service_employee_booking_accrual_period_idx
  ON service_employee_booking_accrual(
    tenant_id,employee_resource_id,status,created_at
  );

CREATE TABLE service_employee_payroll_statement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  employee_resource_id uuid NOT NULL REFERENCES service_resource(id) ON DELETE RESTRICT,
  period_from date NOT NULL,
  period_to date NOT NULL,
  variable_minor bigint NOT NULL DEFAULT 0 CHECK (variable_minor >= 0),
  monthly_base_minor bigint NOT NULL DEFAULT 0 CHECK (monthly_base_minor >= 0),
  daily_base_minor bigint NOT NULL DEFAULT 0 CHECK (daily_base_minor >= 0),
  guarantee_adjustment_minor bigint NOT NULL DEFAULT 0
    CHECK (guarantee_adjustment_minor >= 0),
  adjustment_minor bigint NOT NULL DEFAULT 0,
  total_minor bigint NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'RUB',
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','FINALIZED','EXPORTED','PAID','CANCELLED')),
  calculation_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  finalized_at timestamptz,
  finalized_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from),
  UNIQUE (tenant_id,employee_resource_id,period_from,period_to)
);

CREATE INDEX service_employee_payroll_statement_period_idx
  ON service_employee_payroll_statement(
    tenant_id,period_from,status,employee_resource_id
  );

CREATE OR REPLACE FUNCTION corebiz_service_employee_plan_guard()
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
      AND r.id=NEW.employee_resource_id
      AND r.type='EMPLOYEE'
      AND r.status='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'SERVICE_EMPLOYEE_PLAN_RESOURCE_INVALID'
      USING ERRCODE='23514';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      NEW.tenant_id::text || '|service-employee-plan|' ||
      NEW.employee_resource_id::text || '|' ||
      coalesce(NEW.service_id::text,'*') || '|' ||
      coalesce(NEW.delivery_format,'*') || '|' ||
      coalesce(NEW.branch_id::text,'*') || '|' ||
      NEW.priority::text,
      0
    )
  );

  IF EXISTS (
    SELECT 1
    FROM service_employee_compensation_plan p
    WHERE p.tenant_id=NEW.tenant_id
      AND p.employee_resource_id=NEW.employee_resource_id
      AND p.service_id IS NOT DISTINCT FROM NEW.service_id
      AND p.delivery_format IS NOT DISTINCT FROM NEW.delivery_format
      AND p.branch_id IS NOT DISTINCT FROM NEW.branch_id
      AND p.priority=NEW.priority
      AND p.status='ACTIVE'
      AND p.id<>NEW.id
      AND daterange(p.valid_from,p.valid_to,'[]')
          && daterange(NEW.valid_from,NEW.valid_to,'[]')
  ) THEN
    RAISE EXCEPTION 'SERVICE_EMPLOYEE_PLAN_OVERLAP'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER service_employee_compensation_plan_guard_v1
BEFORE INSERT OR UPDATE OF
  employee_resource_id,service_id,delivery_format,branch_id,
  priority,valid_from,valid_to,status
ON service_employee_compensation_plan
FOR EACH ROW EXECUTE FUNCTION corebiz_service_employee_plan_guard();

CREATE OR REPLACE FUNCTION corebiz_service_employee_profile_guard()
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
      AND r.id=NEW.employee_resource_id
      AND r.type='EMPLOYEE'
      AND r.status='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'SERVICE_EMPLOYEE_PROFILE_RESOURCE_INVALID'
      USING ERRCODE='23514';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      NEW.tenant_id::text || '|service-employee-profile|' ||
      NEW.employee_resource_id::text,
      0
    )
  );

  IF EXISTS (
    SELECT 1
    FROM service_employee_payroll_profile p
    WHERE p.tenant_id=NEW.tenant_id
      AND p.employee_resource_id=NEW.employee_resource_id
      AND p.id<>NEW.id
      AND p.status='ACTIVE'
      AND daterange(p.valid_from,p.valid_to,'[]')
          && daterange(NEW.valid_from,NEW.valid_to,'[]')
  ) THEN
    RAISE EXCEPTION 'SERVICE_EMPLOYEE_PROFILE_OVERLAP'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER service_employee_payroll_profile_guard_v1
BEFORE INSERT OR UPDATE OF
  employee_resource_id,valid_from,valid_to,status
ON service_employee_payroll_profile
FOR EACH ROW EXECUTE FUNCTION corebiz_service_employee_profile_guard();

CREATE OR REPLACE FUNCTION corebiz_service_profitability_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Service booking profitability snapshot is immutable'
    USING ERRCODE='23514';
END;
$$;

CREATE TRIGGER service_booking_profitability_immutable_v1
BEFORE UPDATE OR DELETE ON service_booking_profitability
FOR EACH ROW EXECUTE FUNCTION corebiz_service_profitability_immutable();

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'service_employee_compensation_plan',
    'service_employee_compensation_component',
    'service_employee_payroll_profile',
    'service_booking_profitability',
    'service_employee_booking_accrual',
    'service_employee_payroll_statement'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      tbl || '_isolation',tbl
    );
  END LOOP;
END;
$$;

CREATE TRIGGER service_employee_compensation_plan_tenant_refs_v1
BEFORE INSERT OR UPDATE ON service_employee_compensation_plan
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'employee_resource_id','service_resource',
  'service_id','service_catalog_item',
  'branch_id','branch'
);

CREATE TRIGGER service_employee_compensation_component_tenant_refs_v1
BEFORE INSERT OR UPDATE ON service_employee_compensation_component
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'plan_id','service_employee_compensation_plan'
);

CREATE TRIGGER service_employee_payroll_profile_tenant_refs_v1
BEFORE INSERT OR UPDATE ON service_employee_payroll_profile
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'employee_resource_id','service_resource'
);

CREATE TRIGGER service_booking_profitability_tenant_refs_v1
BEFORE INSERT OR UPDATE ON service_booking_profitability
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'booking_id','service_booking',
  'employee_resource_id','service_resource'
);

CREATE TRIGGER service_employee_booking_accrual_tenant_refs_v1
BEFORE INSERT OR UPDATE ON service_employee_booking_accrual
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'booking_id','service_booking',
  'employee_resource_id','service_resource',
  'plan_id','service_employee_compensation_plan'
);

CREATE TRIGGER service_employee_payroll_statement_tenant_refs_v1
BEFORE INSERT OR UPDATE ON service_employee_payroll_statement
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'employee_resource_id','service_resource'
);

COMMIT;
