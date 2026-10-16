BEGIN;

-- Platform operators are distinct from tenant owners and tenant roles.
-- Provision operators only through a reviewed, offline DBA procedure.
CREATE TABLE platform_operator (
  user_id uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK(status IN ('ACTIVE','SUSPENDED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON platform_operator FROM PUBLIC;
ALTER TABLE platform_operator ENABLE ROW LEVEL SECURITY;

-- The caller must prove possession of an ACTIVE browser session, not merely
-- supply a user UUID. Only the schema-owner SECURITY DEFINER path may read all
-- tenants; its return value intentionally excludes user emails and secrets.
CREATE FUNCTION corebiz_platform_operator_tenants(
  p_user_id uuid,
  p_session_hash text,
  p_limit integer DEFAULT 25,
  p_offset integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_output jsonb;
BEGIN
  IF p_session_hash IS NULL OR
     p_session_hash !~ '^[0-9a-f]{64}$' OR
     NOT EXISTS (
       SELECT 1
       FROM public.platform_operator op
       JOIN public.app_user u ON u.id=op.user_id
       JOIN public.user_session s ON s.user_id=u.id
       WHERE op.user_id=p_user_id
         AND op.status='ACTIVE'
         AND u.status='ACTIVE'
         AND s.session_hash=p_session_hash
         AND s.revoked_at IS NULL AND s.expires_at>now()
     )
  THEN
    RAISE EXCEPTION 'PLATFORM_OPERATOR_FORBIDDEN'
      USING ERRCODE='42501';
  END IF;

  IF p_limit IS NULL OR p_limit<1 OR p_limit>100 OR
     p_offset IS NULL OR p_offset<0 OR p_offset>100000 THEN
    RAISE EXCEPTION 'PLATFORM_OPERATOR_INVALID_PAGE'
      USING ERRCODE='22023';
  END IF;

  SELECT jsonb_build_object(
    'total',(SELECT count(*) FROM public.tenant),
    'items',coalesce(jsonb_agg(jsonb_build_object(
      'tenantId',q.id,
      'companyName',q.name,
      'tenantStatus',q.status,
      'subscriptionStatus',q.subscription_status,
      'planCode',q.plan_code,
      'periodEnd',q.current_period_end,
      'activeUsers',q.active_users,
      'openTickets',q.open_tickets,
      'createdAt',q.created_at
    ) ORDER BY q.created_at DESC,q.id),'[]'::jsonb)
  )
  INTO v_output
  FROM (
    SELECT t.id,t.name,t.status,t.created_at,
           s.status AS subscription_status,
           p.code AS plan_code,s.current_period_end,
           (SELECT count(*) FROM public.tenant_membership m
            WHERE m.tenant_id=t.id AND m.status='ACTIVE') AS active_users,
           (SELECT count(*) FROM public.support_ticket st
            WHERE st.tenant_id=t.id AND st.status<>'CLOSED') AS open_tickets
    FROM public.tenant t
    LEFT JOIN public.tenant_subscription s ON s.tenant_id=t.id
    LEFT JOIN public.billing_plan p ON p.id=s.plan_id
    ORDER BY t.created_at DESC,t.id
    LIMIT p_limit OFFSET p_offset
  ) q;

  RETURN v_output;
END;
$$;

REVOKE ALL ON FUNCTION
  corebiz_platform_operator_tenants(uuid,text,integer,integer)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='corebiz_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION corebiz_platform_operator_tenants(uuid,text,integer,integer) TO corebiz_app';
  END IF;
END;
$$;

COMMIT;
