BEGIN;

INSERT INTO plan_entitlement(plan_id, entitlement_key, entitlement_value)
SELECT p.id, v.entitlement_key, to_jsonb(v.limit_value)
FROM billing_plan p
JOIN (
  VALUES
    ('START','max_branches',1),
    ('BUSINESS','max_branches',3),
    ('COMMERCE','max_branches',10),
    ('OPERATIONS','max_branches',30),
    ('ENTERPRISE','max_branches',10000),
    ('START','max_warehouses',1),
    ('BUSINESS','max_warehouses',3),
    ('COMMERCE','max_warehouses',10),
    ('OPERATIONS','max_warehouses',30),
    ('ENTERPRISE','max_warehouses',10000),
    ('START','max_service_resources',10),
    ('BUSINESS','max_service_resources',50),
    ('COMMERCE','max_service_resources',150),
    ('OPERATIONS','max_service_resources',500),
    ('ENTERPRISE','max_service_resources',100000)
) AS v(plan_code,entitlement_key,limit_value)
  ON v.plan_code=p.code
ON CONFLICT(plan_id,entitlement_key)
DO UPDATE SET entitlement_value=EXCLUDED.entitlement_value;

CREATE OR REPLACE FUNCTION corebiz_plan_integer_limit(
  p_tenant_id uuid,
  p_entitlement_key text
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
  SELECT CASE
    WHEN jsonb_typeof(e.entitlement_value)='number'
      THEN (e.entitlement_value #>> '{}')::integer
    ELSE NULL
  END
  FROM tenant_subscription s
  JOIN plan_entitlement e
    ON e.plan_id=s.plan_id
   AND e.entitlement_key=p_entitlement_key
  WHERE s.tenant_id=p_tenant_id
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION corebiz_plan_integer_limit(uuid,text) FROM PUBLIC;

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
  FOR SHARE;

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
BEFORE INSERT OR UPDATE OF status
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

CREATE TABLE tenant_plan_limit_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  entitlement_key text NOT NULL,
  used_value integer NOT NULL CHECK(used_value>=0),
  limit_value integer NOT NULL CHECK(limit_value>=0),
  source text NOT NULL DEFAULT 'BILLING',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tenant_plan_limit_event_tenant_idx
  ON tenant_plan_limit_event(tenant_id,created_at DESC);

ALTER TABLE tenant_plan_limit_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_plan_limit_event_isolation
  ON tenant_plan_limit_event
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

COMMIT;
