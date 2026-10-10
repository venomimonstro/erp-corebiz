BEGIN;

ALTER TABLE service_package_plan
  ADD COLUMN IF NOT EXISTS grace_period_days integer NOT NULL DEFAULT 0
    CHECK (grace_period_days BETWEEN 0 AND 3650);

ALTER TABLE service_package
  ADD COLUMN IF NOT EXISTS activation_policy_snapshot text NOT NULL DEFAULT 'FULL_PAYMENT'
    CHECK (activation_policy_snapshot IN ('FULL_PAYMENT','IMMEDIATE','PROPORTIONAL','GRACE_PERIOD')),
  ADD COLUMN IF NOT EXISTS allowed_debt_minor_snapshot bigint NOT NULL DEFAULT 0
    CHECK (allowed_debt_minor_snapshot >= 0),
  ADD COLUMN IF NOT EXISTS grace_period_days_snapshot integer NOT NULL DEFAULT 0
    CHECK (grace_period_days_snapshot BETWEEN 0 AND 3650);

ALTER TABLE service_package
  DROP CONSTRAINT IF EXISTS service_package_status_check;

ALTER TABLE service_package
  ADD CONSTRAINT service_package_status_check
  CHECK (status IN (
    'PENDING_PAYMENT','ACTIVE','EXHAUSTED','EXPIRED','CANCELLED'
  ));

CREATE TABLE service_package_beneficiary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  package_id uuid NOT NULL REFERENCES service_package(id) ON DELETE CASCADE,
  party_id uuid NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','REMOVED')),
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,package_id,party_id)
);

CREATE INDEX service_package_beneficiary_party_idx
  ON service_package_beneficiary(tenant_id,party_id,status);

CREATE TABLE service_package_plan_entitlement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES service_package_plan(id) ON DELETE CASCADE,
  lesson_type text,
  dance_program_id uuid REFERENCES dance_program(id) ON DELETE SET NULL,
  dance_group_id uuid REFERENCES dance_group(id) ON DELETE SET NULL,
  visit_limit integer CHECK (visit_limit IS NULL OR visit_limit > 0),
  management_visit_value_minor bigint NOT NULL DEFAULT 0
    CHECK (management_visit_value_minor >= 0),
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 100000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    lesson_type IS NULL OR lesson_type IN (
      'GROUP','INDIVIDUAL','TRIAL','MASTER_CLASS','OPEN_CLASS',
      'REHEARSAL','RENTAL_EVENT'
    )
  ),
  UNIQUE (
    tenant_id,plan_id,lesson_type,dance_program_id,dance_group_id,priority
  )
);

CREATE INDEX service_package_plan_entitlement_match_idx
  ON service_package_plan_entitlement(
    tenant_id,plan_id,priority,lesson_type,dance_program_id,dance_group_id
  );

CREATE TABLE service_package_entitlement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  package_id uuid NOT NULL REFERENCES service_package(id) ON DELETE CASCADE,
  source_plan_entitlement_id uuid
    REFERENCES service_package_plan_entitlement(id) ON DELETE SET NULL,
  lesson_type text,
  dance_program_id uuid REFERENCES dance_program(id) ON DELETE SET NULL,
  dance_group_id uuid REFERENCES dance_group(id) ON DELETE SET NULL,
  visit_limit_snapshot integer CHECK (
    visit_limit_snapshot IS NULL OR visit_limit_snapshot > 0
  ),
  reserved_visits integer NOT NULL DEFAULT 0 CHECK (reserved_visits >= 0),
  used_visits integer NOT NULL DEFAULT 0 CHECK (used_visits >= 0),
  management_visit_value_minor_snapshot bigint NOT NULL DEFAULT 0
    CHECK (management_visit_value_minor_snapshot >= 0),
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 100000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    visit_limit_snapshot IS NULL
    OR reserved_visits + used_visits <= visit_limit_snapshot
  ),
  CHECK (
    lesson_type IS NULL OR lesson_type IN (
      'GROUP','INDIVIDUAL','TRIAL','MASTER_CLASS','OPEN_CLASS',
      'REHEARSAL','RENTAL_EVENT'
    )
  )
);

CREATE INDEX service_package_entitlement_match_idx
  ON service_package_entitlement(
    tenant_id,package_id,priority,lesson_type,dance_program_id,dance_group_id
  );

ALTER TABLE dance_package_redemption
  ADD COLUMN IF NOT EXISTS package_entitlement_id uuid
    REFERENCES service_package_entitlement(id) ON DELETE SET NULL;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'service_package_beneficiary',
    'service_package_plan_entitlement',
    'service_package_entitlement'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      tbl || '_isolation',
      tbl
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION corebiz_sync_dance_package_activation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NEW.source_type='PACKAGE' AND NEW.source_id IS NOT NULL THEN
    IF NEW.status='PAID' THEN
      UPDATE service_package
      SET status=CASE
            WHEN status='PENDING_PAYMENT' THEN 'ACTIVE'
            ELSE status
          END,
          updated_at=now()
      WHERE tenant_id=NEW.tenant_id AND id=NEW.source_id;
    ELSIF NEW.status='CANCELLED' THEN
      UPDATE service_package
      SET status='CANCELLED',updated_at=now()
      WHERE tenant_id=NEW.tenant_id
        AND id=NEW.source_id
        AND used_visits=0
        AND reserved_visits=0;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_dance_package_activation_v1
  ON dance_student_charge;
CREATE TRIGGER sync_dance_package_activation_v1
AFTER INSERT OR UPDATE OF status ON dance_student_charge
FOR EACH ROW EXECUTE FUNCTION corebiz_sync_dance_package_activation();

COMMIT;
