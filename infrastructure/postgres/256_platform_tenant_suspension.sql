BEGIN;

-- An operator cannot grant themselves a tenant membership or access customer data.
-- Suspension is administrative: it never changes paid periods or invoices.
CREATE TABLE platform_tenant_suspension (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  suspended_by_user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 15 AND 800),
  previous_status text NOT NULL CHECK (previous_status = 'ACTIVE'),
  suspended_at timestamptz NOT NULL DEFAULT now(),
  resumed_at timestamptz,
  resumed_by_user_id uuid REFERENCES app_user(id) ON DELETE RESTRICT,
  resume_reason text,
  CONSTRAINT platform_suspension_resume_pair CHECK (
    (resumed_at IS NULL AND resumed_by_user_id IS NULL AND resume_reason IS NULL)
    OR (resumed_at IS NOT NULL AND resumed_by_user_id IS NOT NULL
        AND resume_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX platform_tenant_one_active_suspension
  ON platform_tenant_suspension(tenant_id) WHERE resumed_at IS NULL;
CREATE INDEX platform_tenant_suspension_tenant_timeline
  ON platform_tenant_suspension(tenant_id,suspended_at DESC);

REVOKE ALL ON platform_tenant_suspension FROM PUBLIC;
ALTER TABLE platform_tenant_suspension ENABLE ROW LEVEL SECURITY;

-- Authenticate the human operator against an ACTIVE, non-revoked session.
-- A known user UUID alone is never sufficient for this privileged operation.
CREATE FUNCTION corebiz_platform_tenant_suspension(
  p_operator_user_id uuid,
  p_session_hash text,
  p_target_tenant_id uuid,
  p_action text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_old_status text;
  v_next_status text;
  v_suspension_id uuid;
BEGIN
  IF p_session_hash IS NULL OR
     p_session_hash !~ '^[0-9a-f]{64}$' OR
     NOT EXISTS (
       SELECT 1 FROM public.platform_operator op
       JOIN public.app_user u ON u.id=op.user_id
       JOIN public.user_session s ON s.user_id=u.id
       WHERE op.user_id=p_operator_user_id
         AND op.status='ACTIVE' AND u.status='ACTIVE'
         AND s.session_hash=p_session_hash
         AND s.revoked_at IS NULL AND s.expires_at>now()
     ) THEN
    RAISE EXCEPTION 'PLATFORM_OPERATOR_FORBIDDEN' USING ERRCODE='42501';
  END IF;

  IF p_target_tenant_id IS NULL OR p_action IS NULL OR
     p_action NOT IN ('SUSPEND','RESUME') OR
     p_reason IS NULL OR
     length(btrim(p_reason)) NOT BETWEEN 15 AND 800 THEN
    RAISE EXCEPTION 'PLATFORM_SUSPENSION_INVALID_REQUEST' USING ERRCODE='22023';
  END IF;

  -- Prevent an operator from suspending a company they are a member of.
  -- This is also a deliberate separation-of-duties boundary.
  IF EXISTS (
    SELECT 1 FROM public.tenant_membership m
    WHERE m.tenant_id=p_target_tenant_id
      AND m.user_id=p_operator_user_id AND m.status<>'LEFT'
  ) THEN
    RAISE EXCEPTION 'PLATFORM_OPERATOR_OWN_TENANT_FORBIDDEN' USING ERRCODE='42501';
  END IF;

  SELECT status INTO v_old_status FROM public.tenant
  WHERE id=p_target_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PLATFORM_TENANT_NOT_FOUND' USING ERRCODE='P0002';
  END IF;

  IF p_action='SUSPEND' THEN
    -- Do not silently erase GRACE, READ_ONLY, CANCELLED or older
    -- suspensions established through another workflow.
    IF v_old_status<>'ACTIVE' THEN
      RAISE EXCEPTION 'PLATFORM_TENANT_NOT_ACTIVE' USING ERRCODE='23514';
    END IF;
    INSERT INTO public.platform_tenant_suspension(
      tenant_id,suspended_by_user_id,reason,previous_status
    ) VALUES (
      p_target_tenant_id,p_operator_user_id,btrim(p_reason),v_old_status
    ) RETURNING id INTO v_suspension_id;

    UPDATE public.tenant SET status='SUSPENDED',updated_at=now()
    WHERE id=p_target_tenant_id;

    -- Existing browser cookies for this tenant must not survive suspension.
    -- Other memberships / tenants are unaffected.
    UPDATE public.user_session s SET revoked_at=now()
    WHERE s.revoked_at IS NULL AND s.active_membership_id IN (
      SELECT m.id FROM public.tenant_membership m
      WHERE m.tenant_id=p_target_tenant_id
    );
    v_next_status:='SUSPENDED';
  ELSE
    IF v_old_status<>'SUSPENDED' THEN
      RAISE EXCEPTION 'PLATFORM_TENANT_NOT_SUSPENDED' USING ERRCODE='23514';
    END IF;

    UPDATE public.platform_tenant_suspension
    SET resumed_at=now(),resumed_by_user_id=p_operator_user_id,
        resume_reason=btrim(p_reason)
    WHERE tenant_id=p_target_tenant_id AND resumed_at IS NULL
    RETURNING id INTO v_suspension_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PLATFORM_SUSPENSION_RECORD_REQUIRED' USING ERRCODE='23514';
    END IF;

    UPDATE public.tenant SET status='ACTIVE',updated_at=now()
    WHERE id=p_target_tenant_id;
    v_next_status:='ACTIVE';
  END IF;

  INSERT INTO public.audit_event(
    tenant_id,actor_user_id,actor_membership_id,action,resource_type,
    resource_id,before_data,after_data,reason
  ) VALUES (
    p_target_tenant_id,p_operator_user_id,NULL,
    CASE WHEN p_action='SUSPEND' THEN 'platform.tenant_suspended'
         ELSE 'platform.tenant_resumed' END,
    'tenant',p_target_tenant_id::text,
    pg_catalog.jsonb_build_object('status',v_old_status),
    pg_catalog.jsonb_build_object('status',v_next_status,
                                  'suspensionId',v_suspension_id),
    btrim(p_reason)
  );

  RETURN pg_catalog.jsonb_build_object(
    'tenantId',p_target_tenant_id,'status',v_next_status,
    'suspensionId',v_suspension_id
  );
END;
$$;

REVOKE ALL ON FUNCTION
  corebiz_platform_tenant_suspension(uuid,text,uuid,text,text)
  FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='corebiz_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION corebiz_platform_tenant_suspension(uuid,text,uuid,text,text) TO corebiz_app';
  END IF;
END;
$$;
COMMIT;
