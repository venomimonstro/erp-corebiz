BEGIN;

-- A platform operator can review only platform suspension decisions.
-- The function does not expose business records, user email or login secrets.
CREATE FUNCTION corebiz_platform_suspension_history(
  p_user_id uuid,
  p_session_hash text,
  p_tenant_id uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_output jsonb;
BEGIN
  IF p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$'
    OR NOT EXISTS (
      SELECT 1 FROM public.platform_operator op
      JOIN public.app_user u ON u.id=op.user_id
      JOIN public.user_session s ON s.user_id=u.id
      WHERE op.user_id=p_user_id AND op.status='ACTIVE'
        AND u.status='ACTIVE' AND s.session_hash=p_session_hash
        AND s.revoked_at IS NULL AND s.expires_at>now()
    )
  THEN
    RAISE EXCEPTION 'PLATFORM_OPERATOR_FORBIDDEN' USING ERRCODE='42501';
  END IF;

  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'PLATFORM_HISTORY_TENANT_REQUIRED' USING ERRCODE='22023';
  END IF;

  SELECT coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'id',x.id,
      'suspendedAt',x.suspended_at,
      'resumedAt',x.resumed_at,
      'reason',x.reason,
      'resumeReason',x.resume_reason
    ) ORDER BY x.suspended_at DESC,x.id
  ),'[]'::jsonb) INTO v_output
  FROM (
    SELECT id,suspended_at,resumed_at,reason,resume_reason
    FROM public.platform_tenant_suspension
    WHERE tenant_id=p_tenant_id
    ORDER BY suspended_at DESC,id
    LIMIT 25
  ) x;

  RETURN v_output;
END;
$$;

REVOKE ALL ON FUNCTION corebiz_platform_suspension_history(uuid,text,uuid)
  FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='corebiz_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION corebiz_platform_suspension_history(uuid,text,uuid) TO corebiz_app';
  END IF;
END;
$$;
COMMIT;
