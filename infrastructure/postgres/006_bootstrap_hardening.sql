BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS crm_pipeline_one_active_default_uq
  ON crm_pipeline(tenant_id)
  WHERE is_default = true AND status = 'ACTIVE';

ALTER FUNCTION corebiz_seed_tenant_roles(uuid)
  SECURITY DEFINER;

ALTER FUNCTION corebiz_seed_tenant_roles(uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION corebiz_tenant_role_bootstrap_trigger()
  SECURITY DEFINER;

ALTER FUNCTION corebiz_tenant_role_bootstrap_trigger()
  SET search_path = public, pg_temp;

ALTER FUNCTION corebiz_membership_role_bootstrap_trigger()
  SECURITY DEFINER;

ALTER FUNCTION corebiz_membership_role_bootstrap_trigger()
  SET search_path = public, pg_temp;

ALTER FUNCTION corebiz_seed_tenant_crm(uuid)
  SECURITY DEFINER;

ALTER FUNCTION corebiz_seed_tenant_crm(uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION corebiz_tenant_crm_bootstrap_trigger()
  SECURITY DEFINER;

ALTER FUNCTION corebiz_tenant_crm_bootstrap_trigger()
  SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION corebiz_seed_tenant_roles(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION corebiz_seed_tenant_crm(uuid) FROM PUBLIC;

COMMIT;
