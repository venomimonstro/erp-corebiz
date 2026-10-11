BEGIN;

ALTER TABLE work_project
  DROP CONSTRAINT IF EXISTS work_project_billing_mode_check;

ALTER TABLE work_project
  ADD CONSTRAINT work_project_billing_mode_check
  CHECK(billing_mode IN (
    'FIXED','TIME_AND_MATERIAL','RETAINER','MILESTONE','INTERNAL'
  ));

ALTER TABLE work_project
  ADD COLUMN IF NOT EXISTS project_type text,
  ADD COLUMN IF NOT EXISTS monthly_retainer_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS media_budget_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS target_margin_bps integer,
  ADD COLUMN IF NOT EXISTS client_contact_party_id uuid
    REFERENCES party(id) ON DELETE SET NULL;

ALTER TABLE work_project
  DROP CONSTRAINT IF EXISTS work_project_monthly_retainer_ck,
  DROP CONSTRAINT IF EXISTS work_project_media_budget_ck,
  DROP CONSTRAINT IF EXISTS work_project_target_margin_ck;

ALTER TABLE work_project
  ADD CONSTRAINT work_project_monthly_retainer_ck
    CHECK(monthly_retainer_minor>=0),
  ADD CONSTRAINT work_project_media_budget_ck
    CHECK(media_budget_minor>=0),
  ADD CONSTRAINT work_project_target_margin_ck
    CHECK(target_margin_bps IS NULL OR target_margin_bps BETWEEN 0 AND 10000);

CREATE TABLE work_project_member (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES work_project(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL
    REFERENCES tenant_membership(id) ON DELETE CASCADE,
  role_code text NOT NULL DEFAULT 'SPECIALIST',
  billable_rate_minor bigint NOT NULL DEFAULT 0 CHECK(billable_rate_minor>=0),
  cost_rate_minor bigint NOT NULL DEFAULT 0 CHECK(cost_rate_minor>=0),
  allocation_percent integer NOT NULL DEFAULT 100
    CHECK(allocation_percent BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK(status IN ('ACTIVE','ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,project_id,membership_id)
);

CREATE TABLE work_project_deliverable (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES work_project(id) ON DELETE CASCADE,
  milestone_id uuid REFERENCES work_project_milestone(id) ON DELETE SET NULL,
  title text NOT NULL,
  deliverable_type text NOT NULL DEFAULT 'OTHER'
    CHECK(deliverable_type IN (
      'DESIGN','DEVELOPMENT','SEO','CONTENT','ADVERTISING',
      'ANALYTICS','STRATEGY','REPORT','OTHER'
    )),
  status text NOT NULL DEFAULT 'PLANNED'
    CHECK(status IN (
      'PLANNED','IN_PROGRESS','INTERNAL_REVIEW',
      'CLIENT_REVIEW','APPROVED','REWORK','CANCELLED'
    )),
  due_at timestamptz,
  client_approval_required boolean NOT NULL DEFAULT true,
  approved_at timestamptz,
  approved_by_party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  approval_note text,
  version integer NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX work_project_deliverable_idx
  ON work_project_deliverable(tenant_id,project_id,status,due_at);

CREATE TABLE work_project_monthly_statement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES work_project(id) ON DELETE CASCADE,
  period_key text NOT NULL,
  period_from date NOT NULL,
  period_to date NOT NULL,
  service_revenue_minor bigint NOT NULL DEFAULT 0 CHECK(service_revenue_minor>=0),
  media_budget_minor bigint NOT NULL DEFAULT 0 CHECK(media_budget_minor>=0),
  labor_cost_minor bigint NOT NULL DEFAULT 0 CHECK(labor_cost_minor>=0),
  other_cost_minor bigint NOT NULL DEFAULT 0 CHECK(other_cost_minor>=0),
  gross_margin_minor bigint NOT NULL DEFAULT 0,
  margin_bps integer,
  billable_minutes integer NOT NULL DEFAULT 0 CHECK(billable_minutes>=0),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK(status IN ('DRAFT','FINALIZED','INVOICED','PAID','CANCELLED')),
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(period_from<=period_to),
  CHECK(margin_bps IS NULL OR margin_bps BETWEEN -100000 AND 10000),
  UNIQUE(tenant_id,project_id,period_key)
);

CREATE TABLE work_project_client_approval (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES work_project(id) ON DELETE CASCADE,
  deliverable_id uuid
    REFERENCES work_project_deliverable(id) ON DELETE CASCADE,
  request_type text NOT NULL
    CHECK(request_type IN (
      'DELIVERABLE','BUDGET','SCOPE_CHANGE','CAMPAIGN_LAUNCH','OTHER'
    )),
  title text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED')),
  response_note text,
  responded_at timestamptz,
  responded_by_party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  created_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX work_project_client_approval_due_idx
  ON work_project_client_approval(
    tenant_id,project_id,status,due_at
  );

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'work_project_member',
    'work_project_deliverable',
    'work_project_monthly_statement',
    'work_project_client_approval'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I
       USING (
         tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid
       )
       WITH CHECK (
         tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid
       )',
      tbl||'_isolation',tbl
    );
  END LOOP;
END;
$$;

COMMIT;
