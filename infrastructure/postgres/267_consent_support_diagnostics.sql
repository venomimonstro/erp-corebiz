BEGIN;

-- Replace the ambiguous historical "read" grant with one narrow, auditable
-- consent capability: platform diagnostics. Existing unconsumed grants are
-- revoked because their scopes were client-controlled and never formed a safe
-- operator authorization contract.
ALTER TABLE support_access_grant
  ADD COLUMN IF NOT EXISTS ticket_id uuid
    REFERENCES support_ticket(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz,
  ADD COLUMN IF NOT EXISTS consumed_by_operator_user_id uuid
    REFERENCES app_user(id) ON DELETE SET NULL;

UPDATE support_access_grant
SET scopes='["diagnostics"]'::jsonb,
    revoked_at=COALESCE(revoked_at,now())
WHERE scopes<>'["diagnostics"]'::jsonb;

ALTER TABLE support_access_grant
  DROP CONSTRAINT IF EXISTS support_access_grant_scope_check;
ALTER TABLE support_access_grant
  ADD CONSTRAINT support_access_grant_scope_check
  CHECK(scopes='["diagnostics"]'::jsonb);

ALTER TABLE support_access_grant
  DROP CONSTRAINT IF EXISTS support_access_grant_token_hash_check;
ALTER TABLE support_access_grant
  ADD CONSTRAINT support_access_grant_token_hash_check
  CHECK(token_hash~'^[0-9a-f]{64}$');

CREATE TABLE support_operator_grant_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  grant_id uuid NOT NULL REFERENCES support_access_grant(id) ON DELETE CASCADE,
  operator_user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  operator_session_id uuid NOT NULL REFERENCES user_session(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(grant_id)
);

CREATE INDEX support_operator_grant_session_operator_idx
  ON support_operator_grant_session(
    operator_user_id,operator_session_id,expires_at
  )
  WHERE ended_at IS NULL;

ALTER TABLE support_operator_grant_session ENABLE ROW LEVEL SECURITY;
CREATE POLICY support_operator_grant_session_isolation
  ON support_operator_grant_session
  USING(
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK(
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

REVOKE ALL ON support_operator_grant_session FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.corebiz_platform_support_claim_diagnostics(
  p_user_id uuid,
  p_session_hash text,
  p_token_hash text
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_session_id uuid;
  v_grant public.support_access_grant%ROWTYPE;
  v_access_id uuid;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SUPPORT_DIAGNOSTICS_TOKEN_INVALID'
      USING ERRCODE='22023';
  END IF;

  SELECT s.id INTO v_session_id
  FROM public.platform_operator op
  JOIN public.app_user u
    ON u.id=op.user_id AND u.status='ACTIVE'
  JOIN public.user_session s
    ON s.user_id=u.id
  WHERE op.user_id=p_user_id
    AND op.status='ACTIVE'
    AND s.session_hash=p_session_hash
    AND s.revoked_at IS NULL
    AND s.expires_at>now()
    AND s.mfa_verified_at IS NOT NULL
  LIMIT 1;

  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'PLATFORM_OPERATOR_MFA_REQUIRED'
      USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_grant
  FROM public.support_access_grant
  WHERE token_hash=p_token_hash
    AND scopes='["diagnostics"]'::jsonb
    AND revoked_at IS NULL
    AND consumed_at IS NULL
    AND expires_at>now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUPPORT_DIAGNOSTICS_GRANT_UNAVAILABLE'
      USING ERRCODE='P0002';
  END IF;

  UPDATE public.support_access_grant
  SET consumed_at=now(),
      consumed_by_operator_user_id=p_user_id
  WHERE id=v_grant.id
    AND consumed_at IS NULL;

  INSERT INTO public.support_operator_grant_session(
    tenant_id,grant_id,operator_user_id,operator_session_id,expires_at
  ) VALUES(
    v_grant.tenant_id,v_grant.id,p_user_id,v_session_id,v_grant.expires_at
  )
  RETURNING id INTO v_access_id;

  INSERT INTO public.audit_event(
    tenant_id,actor_user_id,action,resource_type,resource_id,after_data
  ) VALUES(
    v_grant.tenant_id,p_user_id,'support.diagnostics_claimed',
    'support_access_grant',v_grant.id::text,
    pg_catalog.jsonb_build_object(
      'accessId',v_access_id,
      'ticketId',v_grant.ticket_id,
      'expiresAt',v_grant.expires_at
    )
  );

  RETURN pg_catalog.jsonb_build_object(
    'accessId',v_access_id,
    'tenantId',v_grant.tenant_id,
    'ticketId',v_grant.ticket_id,
    'expiresAt',v_grant.expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_platform_support_diagnostics(
  p_user_id uuid,
  p_session_hash text,
  p_access_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_access public.support_operator_grant_session%ROWTYPE;
  v_result jsonb;
BEGIN
  SELECT gs.* INTO v_access
  FROM public.support_operator_grant_session gs
  JOIN public.support_access_grant g
    ON g.id=gs.grant_id AND g.tenant_id=gs.tenant_id
  JOIN public.user_session s
    ON s.id=gs.operator_session_id
   AND s.user_id=gs.operator_user_id
  JOIN public.platform_operator op
    ON op.user_id=gs.operator_user_id AND op.status='ACTIVE'
  WHERE gs.id=p_access_id
    AND gs.operator_user_id=p_user_id
    AND s.session_hash=p_session_hash
    AND s.revoked_at IS NULL
    AND s.expires_at>now()
    AND s.mfa_verified_at IS NOT NULL
    AND gs.ended_at IS NULL
    AND gs.expires_at>now()
    AND g.revoked_at IS NULL
    AND g.expires_at>now()
  FOR UPDATE OF gs;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUPPORT_DIAGNOSTICS_ACCESS_UNAVAILABLE'
      USING ERRCODE='42501';
  END IF;

  UPDATE public.support_operator_grant_session
  SET last_used_at=now()
  WHERE id=v_access.id;

  SELECT pg_catalog.jsonb_build_object(
    'tenant',pg_catalog.jsonb_build_object(
      'id',t.id,
      'name',t.name,
      'status',t.status
    ),
    'subscription',(
      SELECT pg_catalog.jsonb_build_object(
        'plan',bp.code,
        'status',s.status,
        'periodEnd',s.current_period_end,
        'graceUntil',s.grace_until,
        'cancelAtPeriodEnd',s.cancel_at_period_end
      )
      FROM public.tenant_subscription s
      JOIN public.billing_plan bp ON bp.id=s.plan_id
      WHERE s.tenant_id=t.id
    ),
    'capabilities',COALESCE((
      SELECT pg_catalog.jsonb_agg(c.capability_key ORDER BY c.capability_key)
      FROM public.capability_toggle c
      WHERE c.tenant_id=t.id AND c.enabled=true
    ),'[]'::jsonb),
    'connections',COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'provider',c.provider,
          'status',c.status,
          'lastSyncedAt',c.last_synced_at,
          'lastReceivedAt',c.last_received_at
        ) ORDER BY c.provider,c.id
      )
      FROM public.channel_connection c
      WHERE c.tenant_id=t.id
    ),'[]'::jsonb),
    'openIssues',COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'code',q.issue_code,'count',q.issue_count
        ) ORDER BY q.issue_code
      )
      FROM (
        SELECT i.issue_code,count(*)::integer AS issue_count
        FROM public.tenant_operational_issue i
        WHERE i.tenant_id=t.id AND i.state='OPEN'
        GROUP BY i.issue_code
      ) q
    ),'[]'::jsonb),
    'support',pg_catalog.jsonb_build_object(
      'openTickets',(
        SELECT count(*)::integer
        FROM public.support_ticket st
        WHERE st.tenant_id=t.id AND st.status<>'CLOSED'
      )
    ),
    'migration',COALESCE((
      SELECT pg_catalog.jsonb_object_agg(q.status,q.cnt)
      FROM (
        SELECT mb.status,count(*)::integer AS cnt
        FROM public.migration_batch mb
        WHERE mb.tenant_id=t.id
        GROUP BY mb.status
      ) q
    ),'{}'::jsonb),
    'exports',COALESCE((
      SELECT pg_catalog.jsonb_object_agg(q.status,q.cnt)
      FROM (
        SELECT ej.status,count(*)::integer AS cnt
        FROM public.tenant_export_job ej
        WHERE ej.tenant_id=t.id
        GROUP BY ej.status
      ) q
    ),'{}'::jsonb),
    'access',pg_catalog.jsonb_build_object(
      'id',v_access.id,
      'expiresAt',v_access.expires_at
    )
  )
  INTO v_result
  FROM public.tenant t
  WHERE t.id=v_access.tenant_id;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'SUPPORT_DIAGNOSTICS_TENANT_UNAVAILABLE'
      USING ERRCODE='P0002';
  END IF;

  INSERT INTO public.audit_event(
    tenant_id,actor_user_id,action,resource_type,resource_id,after_data
  ) VALUES(
    v_access.tenant_id,p_user_id,'support.diagnostics_viewed',
    'support_access_grant',v_access.grant_id::text,
    pg_catalog.jsonb_build_object('accessId',v_access.id)
  );

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_platform_support_end_diagnostics(
  p_user_id uuid,
  p_session_hash text,
  p_access_id uuid
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_tenant_id uuid;
  v_grant_id uuid;
BEGIN
  UPDATE public.support_operator_grant_session gs
  SET ended_at=now(),last_used_at=now()
  FROM public.user_session s
  JOIN public.platform_operator op
    ON op.user_id=s.user_id AND op.status='ACTIVE'
  WHERE gs.id=p_access_id
    AND gs.operator_user_id=p_user_id
    AND gs.operator_session_id=s.id
    AND s.user_id=p_user_id
    AND s.session_hash=p_session_hash
    AND s.revoked_at IS NULL
    AND s.expires_at>now()
    AND s.mfa_verified_at IS NOT NULL
    AND gs.ended_at IS NULL
  RETURNING gs.tenant_id,gs.grant_id INTO v_tenant_id,v_grant_id;

  IF v_tenant_id IS NULL THEN RETURN false; END IF;

  INSERT INTO public.audit_event(
    tenant_id,actor_user_id,action,resource_type,resource_id,after_data
  ) VALUES(
    v_tenant_id,p_user_id,'support.diagnostics_ended',
    'support_access_grant',v_grant_id::text,
    pg_catalog.jsonb_build_object('accessId',p_access_id)
  );
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION
  public.corebiz_platform_support_claim_diagnostics(uuid,text,text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.corebiz_platform_support_diagnostics(uuid,text,uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.corebiz_platform_support_end_diagnostics(uuid,text,uuid)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='corebiz_app') THEN
    GRANT EXECUTE ON FUNCTION
      public.corebiz_platform_support_claim_diagnostics(uuid,text,text)
      TO corebiz_app;
    GRANT EXECUTE ON FUNCTION
      public.corebiz_platform_support_diagnostics(uuid,text,uuid)
      TO corebiz_app;
    GRANT EXECUTE ON FUNCTION
      public.corebiz_platform_support_end_diagnostics(uuid,text,uuid)
      TO corebiz_app;
  END IF;
END;
$$;

COMMIT;
