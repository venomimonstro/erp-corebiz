BEGIN;
-- Owner-entered plans are not journal postings, operational cash or earned revenue.
-- NULL means unknown, never convert missing rent/tax to zero.
CREATE TABLE dance_budget_plan (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  month_start date NOT NULL,
  revenue_minor bigint CHECK(revenue_minor IS NULL OR revenue_minor>=0),
  rent_branch_a_minor bigint CHECK(rent_branch_a_minor IS NULL OR rent_branch_a_minor>=0),
  rent_branch_b_minor bigint CHECK(rent_branch_b_minor IS NULL OR rent_branch_b_minor>=0),
  managers_minor bigint CHECK(managers_minor IS NULL OR managers_minor>=0),
  trainers_minor bigint CHECK(trainers_minor IS NULL OR trainers_minor>=0),
  taxes_minor bigint CHECK(taxes_minor IS NULL OR taxes_minor>=0),
  other_minor bigint CHECK(other_minor IS NULL OR other_minor>=0),
  sublease_minor bigint CHECK(sublease_minor IS NULL OR sublease_minor>=0),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  modified_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,month_start),
  CHECK(EXTRACT(DAY FROM month_start)=1)
);
ALTER TABLE dance_budget_plan ENABLE ROW LEVEL SECURITY;
CREATE POLICY dance_budget_plan_tenant_isolation ON dance_budget_plan
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
COMMIT;
