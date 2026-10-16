BEGIN;

-- Non-identifying aggregate indicators for CoreBiz platform support.
-- This function never exposes emails, customer rows or payment credentials.
CREATE FUNCTION corebiz_platform_operator_summary(
  p_user_id uuid,
  p_session_hash text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_summary jsonb;
BEGIN
  IF p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$' OR
     NOT EXISTS(
       SELECT 1
       FROM public.platform_operator op
       JOIN public.app_user u ON u.id=op.user_id
       JOIN public.user_session s ON s.user_id=u.id
       WHERE op.user_id=p_user_id AND op.status='ACTIVE'
         AND u.status='ACTIVE'
         AND s.session_hash=p_session_hash
         AND s.revoked_at IS NULL AND s.expires_at>now()
     )
  THEN
    RAISE EXCEPTION 'PLATFORM_OPERATOR_FORBIDDEN' USING ERRCODE='42501';
  END IF;

  SELECT pg_catalog.jsonb_build_object(
    'tenants',count(*),
    'operating',count(*) FILTER(WHERE t.status='ACTIVE'),
    'suspended',count(*) FILTER(WHERE t.status='SUSPENDED'),
    'readOnly',count(*) FILTER(WHERE t.status='READ_ONLY'),
    'trial',count(*) FILTER(WHERE s.status='TRIAL'
                                AND s.current_period_end>now()),
    'paidActive',count(*) FILTER(
       WHERE s.status='ACTIVE' AND s.current_period_end>now()
         AND s.last_payment_at IS NOT NULL
         AND s.provider_reference IS NOT NULL
    ),
    'missingSubscription',count(*) FILTER(WHERE s.tenant_id IS NULL),
    'pastDue',count(*) FILTER(WHERE s.status IN ('PAST_DUE','GRACE')),
    'expiredSubscriptions',count(*) FILTER(
      WHERE s.current_period_end<=now()
        AND s.status NOT IN ('CANCELLED')
    )
  ) INTO v_summary
  FROM public.tenant t
  LEFT JOIN public.tenant_subscription s ON s.tenant_id=t.id;

  RETURN v_summary;
END;
$$;
REVOKE ALL ON FUNCTION
  corebiz_platform_operator_summary(uuid,text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='corebiz_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION corebiz_platform_operator_summary(uuid,text) TO corebiz_app';
  END IF;
END;
$$;
COMMIT;
