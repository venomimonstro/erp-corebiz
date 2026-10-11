BEGIN;
CREATE TABLE agency_client_contract (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES work_project(id) ON DELETE CASCADE,
  contract_number text NOT NULL CHECK (length(trim(contract_number)) BETWEEN 2 AND 80),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 2 AND 220),
  contract_type text NOT NULL CHECK (contract_type IN (
    'WEBSITE_BUILD','SUPPORT','SEO','PPC','SMM','MARKETING_RETAINER','OTHER'
  )),
  billing_cycle text NOT NULL CHECK (billing_cycle IN ('ONE_TIME','MONTHLY','QUARTERLY')),
  service_fee_minor bigint NOT NULL CHECK (service_fee_minor>=0),
  client_media_budget_minor bigint NOT NULL DEFAULT 0 CHECK (client_media_budget_minor>=0),
  starts_on date NOT NULL,
  ends_on date,
  renewal_notice_days integer NOT NULL DEFAULT 30
    CHECK (renewal_notice_days BETWEEN 0 AND 365),
  signed_on date,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','ACTIVE','PAUSED','EXPIRED','TERMINATED')),
  notes text,
  version integer NOT NULL DEFAULT 1 CHECK(version>=1),
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on>=starts_on),
  UNIQUE(tenant_id,contract_number),
  CONSTRAINT agency_contract_tenant_project_fk
    FOREIGN KEY (tenant_id,project_id) REFERENCES work_project(tenant_id,id)
);
CREATE INDEX agency_contract_renewal_idx
  ON agency_client_contract(tenant_id,status,ends_on);
CREATE INDEX agency_contract_project_idx
  ON agency_client_contract(tenant_id,project_id,status);
ALTER TABLE agency_client_contract ENABLE ROW LEVEL SECURITY;
CREATE POLICY agency_contract_tenant_isolation ON agency_client_contract
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
COMMIT;