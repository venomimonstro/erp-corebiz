BEGIN;

CREATE TABLE tenant_business_vertical (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  vertical_code text NOT NULL,
  template_version integer NOT NULL CHECK(template_version > 0),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_at timestamptz NOT NULL DEFAULT now(),
  updated_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_business_vertical ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_business_vertical_isolation
  ON tenant_business_vertical
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE INDEX tenant_business_vertical_code_idx
  ON tenant_business_vertical(vertical_code);

COMMIT;
