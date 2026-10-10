BEGIN;

CREATE TABLE tenant_business_profile (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  profile_code text NOT NULL DEFAULT 'GENERAL'
    CHECK(profile_code IN (
      'GENERAL','TRADE','ECOMMERCE','SERVICE','WAREHOUSE_3PL'
    )),
  applied_at timestamptz NOT NULL DEFAULT now(),
  updated_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_business_profile ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_business_profile_isolation
  ON tenant_business_profile
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

INSERT INTO tenant_business_profile(tenant_id,profile_code)
SELECT id,'GENERAL'
FROM tenant
ON CONFLICT (tenant_id) DO NOTHING;

CREATE OR REPLACE FUNCTION corebiz_seed_business_profile(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO tenant_business_profile(tenant_id,profile_code)
  VALUES (p_tenant_id,'GENERAL')
  ON CONFLICT (tenant_id) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION corebiz_seed_business_profile(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION corebiz_tenant_business_profile_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM corebiz_seed_business_profile(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_seed_business_profile
AFTER INSERT ON tenant
FOR EACH ROW
EXECUTE FUNCTION corebiz_tenant_business_profile_trigger();

COMMIT;
