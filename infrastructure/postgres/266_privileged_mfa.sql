BEGIN;

CREATE TABLE user_mfa (
  user_id uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  secret_ciphertext text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('PENDING','ACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  enabled_at timestamptz
);

CREATE TABLE user_mfa_recovery_code (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,code_hash)
);

CREATE INDEX user_mfa_recovery_active_idx
  ON user_mfa_recovery_code(user_id)
  WHERE consumed_at IS NULL;

ALTER TABLE user_session
  ADD COLUMN IF NOT EXISTS mfa_verified_at timestamptz;

REVOKE ALL ON user_mfa FROM PUBLIC;
REVOKE ALL ON user_mfa_recovery_code FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='corebiz_app') THEN
    REVOKE ALL ON user_mfa FROM corebiz_app;
    REVOKE ALL ON user_mfa_recovery_code FROM corebiz_app;
  END IF;
END;
$$;

-- Privilege is data-driven rather than tied only to role names. Any future
-- custom role that can manage roles, platform settings or billing at all-tenant
-- scope automatically becomes MFA-required.
CREATE OR REPLACE FUNCTION public.corebiz_auth_mfa_privileged(
  p_user_id uuid,
  p_membership_id uuid
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
  SELECT
    EXISTS(
      SELECT 1
      FROM public.platform_operator op
      WHERE op.user_id=p_user_id AND op.status='ACTIVE'
    )
    OR EXISTS(
      SELECT 1
      FROM public.tenant_membership m
      WHERE m.id=p_membership_id
        AND m.user_id=p_user_id
        AND m.status='ACTIVE'
        AND m.is_owner=true
    )
    OR EXISTS(
      SELECT 1
      FROM public.tenant_membership m
      JOIN public.membership_role mr
        ON mr.tenant_id=m.tenant_id AND mr.membership_id=m.id
      JOIN public.role_permission rp
        ON rp.tenant_id=mr.tenant_id AND rp.role_id=mr.role_id
      WHERE m.id=p_membership_id
        AND m.user_id=p_user_id
        AND m.status='ACTIVE'
        AND rp.scope='all'
        AND rp.permission_code IN(
          '*','roles.manage','platform.settings.manage','billing.manage'
        )
    )
$$;

REVOKE ALL ON FUNCTION public.corebiz_auth_mfa_privileged(uuid,uuid)
  FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.corebiz_auth_login_identity_v2(
  p_email text
)
RETURNS TABLE(
  id uuid,email text,password_hash text,
  membership_id uuid,tenant_id uuid,tenant_name text,is_owner boolean,
  mfa_required boolean,mfa_enabled boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
  SELECT
    u.id,u.email,u.password_hash,m.id,m.tenant_id,t.name,m.is_owner,
    (
      public.corebiz_auth_mfa_privileged(u.id,m.id)
      OR COALESCE(um.status='ACTIVE',false)
    ) AS mfa_required,
    COALESCE(um.status='ACTIVE',false) AS mfa_enabled
  FROM public.app_user u
  JOIN public.tenant_membership m ON m.user_id=u.id
  JOIN public.tenant t ON t.id=m.tenant_id
  LEFT JOIN public.user_mfa um ON um.user_id=u.id
  WHERE lower(u.email)=lower(p_email)
    AND u.status='ACTIVE'
    AND m.status='ACTIVE'
    AND t.status IN ('ACTIVE','GRACE','READ_ONLY')
  ORDER BY m.is_owner DESC,m.created_at ASC
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.corebiz_auth_resolve_session_v2(
  p_session_hash text
)
RETURNS TABLE(
  session_id uuid,user_id uuid,email text,
  membership_id uuid,tenant_id uuid,tenant_name text,is_owner boolean,
  mfa_required boolean,mfa_enabled boolean,mfa_verified boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
  SELECT
    s.id,u.id,u.email,m.id,m.tenant_id,t.name,m.is_owner,
    (
      public.corebiz_auth_mfa_privileged(u.id,m.id)
      OR COALESCE(um.status='ACTIVE',false)
    ) AS mfa_required,
    COALESCE(um.status='ACTIVE',false) AS mfa_enabled,
    (
      NOT (
        public.corebiz_auth_mfa_privileged(u.id,m.id)
        OR COALESCE(um.status='ACTIVE',false)
      )
      OR s.mfa_verified_at IS NOT NULL
    ) AS mfa_verified
  FROM public.user_session s
  JOIN public.app_user u ON u.id=s.user_id
  JOIN public.tenant_membership m ON m.id=s.active_membership_id
    AND m.user_id=u.id
  JOIN public.tenant t ON t.id=m.tenant_id
  LEFT JOIN public.user_mfa um ON um.user_id=u.id
  WHERE s.session_hash=p_session_hash
    AND s.revoked_at IS NULL
    AND s.expires_at>now()
    AND u.status='ACTIVE'
    AND m.status='ACTIVE'
    AND t.status IN ('ACTIVE','GRACE','READ_ONLY')
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.corebiz_auth_mfa_state(
  p_user_id uuid,
  p_membership_id uuid,
  p_session_id uuid
)
RETURNS TABLE(
  required boolean,
  enabled boolean,
  verified boolean,
  recovery_codes_remaining integer
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
  SELECT
    (
      public.corebiz_auth_mfa_privileged(p_user_id,p_membership_id)
      OR COALESCE(um.status='ACTIVE',false)
    ),
    COALESCE(um.status='ACTIVE',false),
    (
      NOT (
        public.corebiz_auth_mfa_privileged(p_user_id,p_membership_id)
        OR COALESCE(um.status='ACTIVE',false)
      )
      OR s.mfa_verified_at IS NOT NULL
    ),
    (
      SELECT count(*)::integer
      FROM public.user_mfa_recovery_code rc
      WHERE rc.user_id=p_user_id AND rc.consumed_at IS NULL
    )
  FROM public.user_session s
  LEFT JOIN public.user_mfa um ON um.user_id=p_user_id
  WHERE s.id=p_session_id
    AND s.user_id=p_user_id
    AND s.active_membership_id=p_membership_id
    AND s.revoked_at IS NULL
    AND s.expires_at>now()
$$;

CREATE OR REPLACE FUNCTION public.corebiz_auth_mfa_secret(
  p_user_id uuid
)
RETURNS TABLE(status text,secret_ciphertext text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
  SELECT um.status,um.secret_ciphertext
  FROM public.user_mfa um
  JOIN public.app_user u ON u.id=um.user_id AND u.status='ACTIVE'
  WHERE um.user_id=p_user_id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.corebiz_auth_mfa_begin(
  p_user_id uuid,
  p_secret_ciphertext text
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_status text;
BEGIN
  IF p_secret_ciphertext IS NULL
     OR length(p_secret_ciphertext) NOT BETWEEN 40 AND 2000 THEN
    RAISE EXCEPTION 'MFA_SECRET_INVALID' USING ERRCODE='22023';
  END IF;

  PERFORM 1 FROM public.app_user
  WHERE id=p_user_id AND status='ACTIVE'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT status INTO v_status
  FROM public.user_mfa
  WHERE user_id=p_user_id
  FOR UPDATE;

  IF v_status='ACTIVE' THEN
    RAISE EXCEPTION 'MFA_ALREADY_ACTIVE' USING ERRCODE='23514';
  END IF;

  INSERT INTO public.user_mfa(
    user_id,secret_ciphertext,status,enabled_at,updated_at
  ) VALUES(
    p_user_id,p_secret_ciphertext,'PENDING',NULL,now()
  )
  ON CONFLICT(user_id) DO UPDATE
  SET secret_ciphertext=EXCLUDED.secret_ciphertext,
      status='PENDING',
      enabled_at=NULL,
      updated_at=now();

  DELETE FROM public.user_mfa_recovery_code
  WHERE user_id=p_user_id;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_auth_mfa_enable(
  p_user_id uuid,
  p_session_id uuid,
  p_tenant_id uuid,
  p_membership_id uuid,
  p_recovery_hashes text[]
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  IF cardinality(p_recovery_hashes)<>10 THEN
    RAISE EXCEPTION 'MFA_RECOVERY_SET_INVALID' USING ERRCODE='22023';
  END IF;

  SELECT count(DISTINCT x)::integer INTO v_count
  FROM unnest(p_recovery_hashes) x
  WHERE x~'^[0-9a-f]{64}$';
  IF v_count<>10 THEN
    RAISE EXCEPTION 'MFA_RECOVERY_SET_INVALID' USING ERRCODE='22023';
  END IF;

  PERFORM 1
  FROM public.user_session s
  JOIN public.tenant_membership m
    ON m.id=s.active_membership_id AND m.user_id=s.user_id
  WHERE s.id=p_session_id
    AND s.user_id=p_user_id
    AND s.revoked_at IS NULL
    AND s.expires_at>now()
    AND m.id=p_membership_id
    AND m.tenant_id=p_tenant_id
    AND m.status='ACTIVE'
  FOR UPDATE OF s;
  IF NOT FOUND THEN RETURN false; END IF;

  PERFORM 1 FROM public.user_mfa
  WHERE user_id=p_user_id AND status='PENDING'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MFA_SETUP_NOT_PENDING' USING ERRCODE='23514';
  END IF;

  UPDATE public.user_mfa
  SET status='ACTIVE',enabled_at=now(),updated_at=now()
  WHERE user_id=p_user_id;

  DELETE FROM public.user_mfa_recovery_code
  WHERE user_id=p_user_id;
  INSERT INTO public.user_mfa_recovery_code(user_id,code_hash)
  SELECT p_user_id,x FROM unnest(p_recovery_hashes) x;

  UPDATE public.user_session
  SET mfa_verified_at=now()
  WHERE id=p_session_id AND user_id=p_user_id;

  UPDATE public.user_session
  SET revoked_at=now()
  WHERE user_id=p_user_id
    AND id<>p_session_id
    AND revoked_at IS NULL;

  INSERT INTO public.audit_event(
    tenant_id,actor_user_id,actor_membership_id,
    action,resource_type,resource_id
  ) VALUES(
    p_tenant_id,p_user_id,p_membership_id,
    'auth.mfa_enabled','user',p_user_id::text
  );

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_auth_mfa_consume_recovery(
  p_user_id uuid,
  p_code_hash text
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_code_hash IS NULL OR p_code_hash!~'^[0-9a-f]{64}$' THEN
    RETURN false;
  END IF;

  SELECT rc.id INTO v_id
  FROM public.user_mfa_recovery_code rc
  JOIN public.user_mfa um
    ON um.user_id=rc.user_id AND um.status='ACTIVE'
  WHERE rc.user_id=p_user_id
    AND rc.code_hash=p_code_hash
    AND rc.consumed_at IS NULL
  FOR UPDATE OF rc
  LIMIT 1;

  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE public.user_mfa_recovery_code
  SET consumed_at=now()
  WHERE id=v_id;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_auth_mfa_mark_session_verified(
  p_user_id uuid,
  p_session_id uuid
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
BEGIN
  UPDATE public.user_session
  SET mfa_verified_at=now()
  WHERE id=p_session_id
    AND user_id=p_user_id
    AND revoked_at IS NULL
    AND expires_at>now();

  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_auth_mfa_replace_recovery(
  p_user_id uuid,
  p_session_id uuid,
  p_tenant_id uuid,
  p_membership_id uuid,
  p_recovery_hashes text[]
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(DISTINCT x)::integer INTO v_count
  FROM unnest(p_recovery_hashes) x
  WHERE x~'^[0-9a-f]{64}$';
  IF cardinality(p_recovery_hashes)<>10 OR v_count<>10 THEN
    RAISE EXCEPTION 'MFA_RECOVERY_SET_INVALID' USING ERRCODE='22023';
  END IF;

  PERFORM 1
  FROM public.user_session s
  JOIN public.user_mfa um ON um.user_id=s.user_id AND um.status='ACTIVE'
  WHERE s.id=p_session_id
    AND s.user_id=p_user_id
    AND s.active_membership_id=p_membership_id
    AND s.mfa_verified_at IS NOT NULL
    AND s.revoked_at IS NULL
    AND s.expires_at>now()
  FOR UPDATE OF s;
  IF NOT FOUND THEN RETURN false; END IF;

  DELETE FROM public.user_mfa_recovery_code
  WHERE user_id=p_user_id;
  INSERT INTO public.user_mfa_recovery_code(user_id,code_hash)
  SELECT p_user_id,x FROM unnest(p_recovery_hashes) x;

  INSERT INTO public.audit_event(
    tenant_id,actor_user_id,actor_membership_id,
    action,resource_type,resource_id
  ) VALUES(
    p_tenant_id,p_user_id,p_membership_id,
    'auth.mfa_recovery_rotated','user',p_user_id::text
  );

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_auth_mfa_disable(
  p_user_id uuid,
  p_session_id uuid,
  p_tenant_id uuid,
  p_membership_id uuid
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
BEGIN
  IF public.corebiz_auth_mfa_privileged(p_user_id,p_membership_id) THEN
    RAISE EXCEPTION 'MFA_REQUIRED_FOR_PRIVILEGED_ACCOUNT'
      USING ERRCODE='23514';
  END IF;

  PERFORM 1
  FROM public.user_session s
  JOIN public.user_mfa um ON um.user_id=s.user_id AND um.status='ACTIVE'
  WHERE s.id=p_session_id
    AND s.user_id=p_user_id
    AND s.active_membership_id=p_membership_id
    AND s.mfa_verified_at IS NOT NULL
    AND s.revoked_at IS NULL
    AND s.expires_at>now()
  FOR UPDATE OF s;
  IF NOT FOUND THEN RETURN false; END IF;

  DELETE FROM public.user_mfa WHERE user_id=p_user_id;

  UPDATE public.user_session
  SET mfa_verified_at=now()
  WHERE id=p_session_id AND user_id=p_user_id;

  UPDATE public.user_session
  SET revoked_at=now()
  WHERE user_id=p_user_id
    AND id<>p_session_id
    AND revoked_at IS NULL;

  INSERT INTO public.audit_event(
    tenant_id,actor_user_id,actor_membership_id,
    action,resource_type,resource_id
  ) VALUES(
    p_tenant_id,p_user_id,p_membership_id,
    'auth.mfa_disabled','user',p_user_id::text
  );

  RETURN true;
END;
$$;

-- Switching from a low-privilege tenant to a privileged one must not carry an
-- unearned verification state when the account has never enrolled MFA.
CREATE OR REPLACE FUNCTION public.corebiz_auth_switch_tenant(
  p_session_id uuid,p_user_id uuid,p_membership_id uuid
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_changed boolean:=false;
BEGIN
  UPDATE public.user_session s
  SET active_membership_id=m.id,
      mfa_verified_at=CASE
        WHEN public.corebiz_auth_mfa_privileged(p_user_id,m.id)
             AND NOT EXISTS(
               SELECT 1 FROM public.user_mfa um
               WHERE um.user_id=p_user_id AND um.status='ACTIVE'
             )
          THEN NULL
        WHEN EXISTS(
          SELECT 1 FROM public.user_mfa um
          WHERE um.user_id=p_user_id AND um.status='ACTIVE'
        )
          THEN s.mfa_verified_at
        ELSE now()
      END
  FROM public.tenant_membership m
  JOIN public.tenant t ON t.id=m.tenant_id
  JOIN public.app_user u ON u.id=m.user_id
  WHERE s.id=p_session_id
    AND s.user_id=p_user_id
    AND s.revoked_at IS NULL
    AND s.expires_at>now()
    AND m.id=p_membership_id
    AND m.user_id=p_user_id
    AND u.status='ACTIVE'
    AND m.status='ACTIVE'
    AND t.status IN ('ACTIVE','GRACE','READ_ONLY')
  RETURNING true INTO v_changed;

  RETURN COALESCE(v_changed,false);
END;
$$;

REVOKE ALL ON FUNCTION public.corebiz_auth_login_identity_v2(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_auth_resolve_session_v2(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_auth_mfa_state(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_auth_mfa_secret(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_auth_mfa_begin(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_auth_mfa_enable(uuid,uuid,uuid,uuid,text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_auth_mfa_consume_recovery(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_auth_mfa_mark_session_verified(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_auth_mfa_replace_recovery(uuid,uuid,uuid,uuid,text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_auth_mfa_disable(uuid,uuid,uuid,uuid) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='corebiz_app') THEN
    GRANT EXECUTE ON FUNCTION public.corebiz_auth_login_identity_v2(text)
      TO corebiz_app;
    GRANT EXECUTE ON FUNCTION public.corebiz_auth_resolve_session_v2(text)
      TO corebiz_app;
    GRANT EXECUTE ON FUNCTION public.corebiz_auth_mfa_state(uuid,uuid,uuid)
      TO corebiz_app;
    GRANT EXECUTE ON FUNCTION public.corebiz_auth_mfa_secret(uuid)
      TO corebiz_app;
    GRANT EXECUTE ON FUNCTION public.corebiz_auth_mfa_begin(uuid,text)
      TO corebiz_app;
    GRANT EXECUTE ON FUNCTION public.corebiz_auth_mfa_enable(uuid,uuid,uuid,uuid,text[])
      TO corebiz_app;
    GRANT EXECUTE ON FUNCTION public.corebiz_auth_mfa_consume_recovery(uuid,text)
      TO corebiz_app;
    GRANT EXECUTE ON FUNCTION public.corebiz_auth_mfa_mark_session_verified(uuid,uuid)
      TO corebiz_app;
    GRANT EXECUTE ON FUNCTION public.corebiz_auth_mfa_replace_recovery(uuid,uuid,uuid,uuid,text[])
      TO corebiz_app;
    GRANT EXECUTE ON FUNCTION public.corebiz_auth_mfa_disable(uuid,uuid,uuid,uuid)
      TO corebiz_app;
  END IF;
END;
$$;

COMMIT;
