BEGIN;

CREATE TABLE work_project (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  business_number text NOT NULL,
  source_deal_id uuid REFERENCES crm_deal(id) ON DELETE SET NULL,
  party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  responsible_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  name text NOT NULL,
  code text,
  status text NOT NULL DEFAULT 'PLANNED'
    CHECK (status IN ('PLANNED','ACTIVE','ON_HOLD','COMPLETED','CANCELLED')),
  billing_mode text NOT NULL DEFAULT 'FIXED'
    CHECK (billing_mode IN ('FIXED','TIME_AND_MATERIAL','INTERNAL')),
  currency char(3) NOT NULL DEFAULT 'RUB',
  budget_minor bigint NOT NULL DEFAULT 0 CHECK (budget_minor >= 0),
  hourly_rate_minor bigint NOT NULL DEFAULT 0 CHECK (hourly_rate_minor >= 0),
  estimated_minutes integer NOT NULL DEFAULT 0 CHECK (estimated_minutes >= 0),
  starts_on date,
  due_on date,
  notes text,
  version integer NOT NULL DEFAULT 1,
  completed_at timestamptz,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (due_on IS NULL OR starts_on IS NULL OR due_on >= starts_on),
  UNIQUE (tenant_id,business_number),
  UNIQUE (tenant_id,code)
);

CREATE INDEX work_project_party_idx
  ON work_project(tenant_id,party_id,status,due_on);

CREATE INDEX work_project_responsible_idx
  ON work_project(tenant_id,responsible_membership_id,status,due_on);

CREATE INDEX work_project_deal_idx
  ON work_project(tenant_id,source_deal_id)
  WHERE source_deal_id IS NOT NULL;

CREATE TABLE work_project_milestone (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES work_project(id) ON DELETE CASCADE,
  name text NOT NULL,
  position integer NOT NULL DEFAULT 100 CHECK (position >= 0),
  status text NOT NULL DEFAULT 'PLANNED'
    CHECK (status IN ('PLANNED','IN_PROGRESS','DONE','CANCELLED')),
  due_at timestamptz,
  amount_minor bigint NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX work_project_milestone_idx
  ON work_project_milestone(tenant_id,project_id,status,position,due_at);

CREATE TABLE work_project_time_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES work_project(id) ON DELETE CASCADE,
  task_id uuid REFERENCES task(id) ON DELETE SET NULL,
  membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  work_date date NOT NULL DEFAULT current_date,
  minutes integer NOT NULL CHECK (minutes BETWEEN 1 AND 1440),
  billable boolean NOT NULL DEFAULT true,
  hourly_rate_minor_snapshot bigint NOT NULL DEFAULT 0
    CHECK (hourly_rate_minor_snapshot >= 0),
  note text,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX work_project_time_entry_idx
  ON work_project_time_entry(tenant_id,project_id,work_date DESC,membership_id);

CREATE UNIQUE INDEX work_project_time_entry_idempotency_uq
  ON work_project_time_entry(tenant_id,idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE work_project ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_project_milestone ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_project_time_entry ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'work_project',
    'work_project_milestone',
    'work_project_time_entry'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      tbl || '_isolation',
      tbl
    );
  END LOOP;
END;
$$;

COMMIT;
