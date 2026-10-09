BEGIN;

-- Authentication is the only exception to the request tenant context:
-- a login/session has no trusted tenant_id until it has been resolved.
-- These functions execute as the schema owner and expose only tightly scoped
-- lookups. Revoke default EXECUTE from PUBLIC. Grant only to the API runtime role.

CREATE OR REPLACE FUNCTION public.corebiz_auth_login_identity(p_email text)
RETURNS TABLE (
  id uuid, email text, password_hash text,
  membership_id uuid, tenant_id uuid, tenant_name text, is_owner boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT u.id, u.email, u.password_hash, m.id, m.tenant_id, t.name, m.is_owner
  FROM public.app_user u
  JOIN public.tenant_membership m ON m.user_id = u.id
  JOIN public.tenant t ON t.id = m.tenant_id
  WHERE lower(u.email) = lower(p_email)
    AND u.status = 'ACTIVE'
    AND m.status = 'ACTIVE'
    AND t.status IN ('ACTIVE', 'GRACE', 'READ_ONLY')
  ORDER BY m.is_owner DESC, m.created_at ASC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_auth_resolve_session(p_session_hash text)
RETURNS TABLE (
  session_id uuid, user_id uuid, email text,
  membership_id uuid, tenant_id uuid, tenant_name text, is_owner boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT s.id, u.id, u.email, m.id, m.tenant_id, t.name, m.is_owner
  FROM public.user_session s
  JOIN public.app_user u ON u.id = s.user_id
  JOIN public.tenant_membership m ON m.id = s.active_membership_id
    AND m.user_id = u.id
  JOIN public.tenant t ON t.id = m.tenant_id
  WHERE s.session_hash = p_session_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
    AND u.status = 'ACTIVE'
    AND m.status = 'ACTIVE'
    AND t.status IN ('ACTIVE', 'GRACE', 'READ_ONLY')
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_auth_memberships(p_user_id uuid)
RETURNS TABLE (membership_id uuid, tenant_id uuid, tenant_name text, is_owner boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT m.id, m.tenant_id, t.name, m.is_owner
  FROM public.tenant_membership m
  JOIN public.tenant t ON t.id = m.tenant_id
  JOIN public.app_user u ON u.id = m.user_id
  WHERE m.user_id = p_user_id
    AND u.status = 'ACTIVE'
    AND m.status = 'ACTIVE'
    AND t.status IN ('ACTIVE', 'GRACE', 'READ_ONLY')
  ORDER BY m.is_owner DESC, t.name ASC;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_auth_switch_tenant(
  p_session_id uuid, p_user_id uuid, p_membership_id uuid
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_changed boolean := false;
BEGIN
  UPDATE public.user_session s
  SET active_membership_id = m.id
  FROM public.tenant_membership m
  JOIN public.tenant t ON t.id = m.tenant_id
  JOIN public.app_user u ON u.id = m.user_id
  WHERE s.id = p_session_id
    AND s.user_id = p_user_id
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
    AND m.id = p_membership_id
    AND m.user_id = p_user_id
    AND u.status = 'ACTIVE'
    AND m.status = 'ACTIVE'
    AND t.status IN ('ACTIVE', 'GRACE', 'READ_ONLY')
  RETURNING true INTO v_changed;
  RETURN coalesce(v_changed, false);
END;
$$;

-- Invitation token is a high-entropy secret. Verify the logged-in user against
-- the invitation email inside the same locked transaction before granting access.
CREATE OR REPLACE FUNCTION public.corebiz_auth_accept_invitation(
  p_user_id uuid, p_token_hash text
)
RETURNS TABLE (tenant_id uuid, membership_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_invite record;
  v_membership_id uuid;
BEGIN
  SELECT i.id, i.tenant_id
  INTO v_invite
  FROM public.tenant_invitation i
  JOIN public.app_user u ON u.id = p_user_id
    AND lower(u.email) = lower(i.email)
    AND u.status = 'ACTIVE'
  JOIN public.tenant t ON t.id = i.tenant_id
    AND t.status IN ('ACTIVE', 'GRACE', 'READ_ONLY')
  WHERE i.token_hash = p_token_hash
    AND i.status = 'PENDING'
    AND i.expires_at > now()
  FOR UPDATE OF i;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO public.tenant_membership(tenant_id, user_id, status, is_owner)
  VALUES (v_invite.tenant_id, p_user_id, 'ACTIVE', false)
  ON CONFLICT (tenant_id, user_id)
  DO UPDATE SET status = 'ACTIVE'
  RETURNING id INTO v_membership_id;

  UPDATE public.tenant_invitation
  SET status = 'ACCEPTED', accepted_at = now()
  WHERE id = v_invite.id;

  INSERT INTO public.audit_event(
    tenant_id, actor_user_id, actor_membership_id,
    action, resource_type, resource_id
  ) VALUES (
    v_invite.tenant_id, p_user_id, v_membership_id,
    'membership.accepted', 'tenant_membership', v_membership_id::text
  );

  RETURN QUERY SELECT v_invite.tenant_id, v_membership_id;
END;
$$;

REVOKE ALL ON FUNCTION public.corebiz_auth_login_identity(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_auth_resolve_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_auth_memberships(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_auth_switch_tenant(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_auth_accept_invitation(uuid,text) FROM PUBLIC;

-- The database must create its runtime role before migrations.
-- Never grant these to PUBLIC or an untrusted reporting role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'corebiz_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.corebiz_auth_login_identity(text) TO corebiz_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.corebiz_auth_resolve_session(text) TO corebiz_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.corebiz_auth_memberships(uuid) TO corebiz_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.corebiz_auth_switch_tenant(uuid,uuid,uuid) TO corebiz_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.corebiz_auth_accept_invitation(uuid,text) TO corebiz_app';
  END IF;
END;
$$;

COMMIT;
