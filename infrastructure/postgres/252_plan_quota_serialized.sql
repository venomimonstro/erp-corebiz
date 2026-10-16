-- Protect plan cardinality under concurrent inserts, reactivations and tenant moves.
-- A FOR SHARE lock allowed concurrent transactions to count the same free slot.
-- Serialize tenant quota mutations through the subscription row.
BEGIN;

CREATE OR REPLACE FUNCTION corebiz_enforce_plan_active_row_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_key text;
  v_limit integer;
  v_used integer;
BEGIN
  IF NEW.status IS DISTINCT FROM 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  v_key := TG_ARGV[0];
  IF v_key IS NULL OR length(v_key)=0 THEN
    RAISE EXCEPTION 'PLAN_LIMIT_KEY_MISSING';
  END IF;

  PERFORM 1
  FROM tenant_subscription
  WHERE tenant_id=NEW.tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PLAN_SUBSCRIPTION_MISSING:%',NEW.tenant_id
      USING ERRCODE='23514';
  END IF;

  v_limit := corebiz_plan_integer_limit(NEW.tenant_id,v_key);
  IF v_limit IS NULL THEN
    RETURN NEW;
  END IF;

  EXECUTE format(
    'SELECT count(*)::integer
       FROM %I
      WHERE tenant_id=$1
        AND status=''ACTIVE''
        AND id<>$2',
    TG_TABLE_NAME
  )
  INTO v_used
  USING NEW.tenant_id,NEW.id;

  IF v_used + 1 > v_limit THEN
    RAISE EXCEPTION 'PLAN_LIMIT_EXCEEDED:%:%:%',
      v_key,v_used + 1,v_limit
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION corebiz_enforce_plan_active_row_limit() FROM PUBLIC;

DROP TRIGGER IF EXISTS tenant_membership_plan_limit_v1 ON tenant_membership;
CREATE TRIGGER tenant_membership_plan_limit_v1
BEFORE INSERT OR UPDATE OF status, tenant_id
ON tenant_membership
FOR EACH ROW
EXECUTE FUNCTION corebiz_enforce_plan_active_row_limit('max_users');

DROP TRIGGER IF EXISTS branch_plan_limit_v1 ON branch;
CREATE TRIGGER branch_plan_limit_v1
BEFORE INSERT OR UPDATE OF status
ON branch
FOR EACH ROW
EXECUTE FUNCTION corebiz_enforce_plan_active_row_limit('max_branches');

DROP TRIGGER IF EXISTS warehouse_plan_limit_v1 ON warehouse;
CREATE TRIGGER warehouse_plan_limit_v1
BEFORE INSERT OR UPDATE OF status
ON warehouse
FOR EACH ROW
EXECUTE FUNCTION corebiz_enforce_plan_active_row_limit('max_warehouses');

DROP TRIGGER IF EXISTS service_resource_plan_limit_v1 ON service_resource;
CREATE TRIGGER service_resource_plan_limit_v1
BEFORE INSERT OR UPDATE OF status
ON service_resource
FOR EACH ROW
EXECUTE FUNCTION corebiz_enforce_plan_active_row_limit('max_service_resources');

COMMIT;
