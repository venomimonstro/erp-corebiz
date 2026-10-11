BEGIN;
ALTER TABLE tenant_invitation
 ADD COLUMN IF NOT EXISTS role_id uuid REFERENCES tenant_role(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tenant_invitation_pending_role_idx
 ON tenant_invitation(tenant_id,role_id,status);

-- One-time acceptance, matching the actual authenticated email (not an
-- email claimed in JSON). The INVITER chooses the role at creation time;
-- OWNER is never assignable by invitation.
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
  v_role_id uuid;
  v_role_code text;
  v_inviter_owner boolean;
BEGIN
  SELECT i.id, i.tenant_id, i.role_id, i.invited_by_user_id
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

  -- Recheck sender authority at redemption. An old link may not grant
  -- a privileged role after its inviter was demoted or removed.
  SELECT tm.is_owner INTO v_inviter_owner
  FROM public.tenant_membership tm
  WHERE tm.tenant_id=v_invite.tenant_id
    AND tm.user_id=v_invite.invited_by_user_id
    AND tm.status='ACTIVE' LIMIT 1;

  IF v_inviter_owner IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.tenant_membership tm
    JOIN public.membership_role mr ON mr.tenant_id=tm.tenant_id
      AND mr.membership_id=tm.id
    JOIN public.role_permission rp ON rp.tenant_id=mr.tenant_id
      AND rp.role_id=mr.role_id
    WHERE tm.tenant_id=v_invite.tenant_id
      AND tm.user_id=v_invite.invited_by_user_id
      AND tm.status='ACTIVE'
      AND rp.permission_code IN ('*','users.manage')
      AND rp.scope='all'
  ) THEN
    RETURN;
  END IF;

  IF v_invite.role_id IS NOT NULL THEN
    SELECT id,code INTO v_role_id,v_role_code
    FROM public.tenant_role
    WHERE tenant_id=v_invite.tenant_id AND id=v_invite.role_id;
    IF v_role_id IS NULL OR v_role_code='OWNER' THEN
      RAISE EXCEPTION 'INVITATION_ROLE_NOT_AVAILABLE';
    END IF;
  ELSE
    SELECT id,code INTO v_role_id,v_role_code
    FROM public.tenant_role
    WHERE tenant_id=v_invite.tenant_id AND code='VIEWER';
  END IF;
  IF v_role_id IS NULL OR v_role_code='OWNER' THEN
    RAISE EXCEPTION 'INVITATION_ROLE_NOT_AVAILABLE';
  END IF;

  IF v_invite.role_id IS NOT NULL AND (
    NOT EXISTS(
      SELECT 1 FROM public.tenant_membership tm
      JOIN public.membership_role mr ON mr.tenant_id=tm.tenant_id
        AND mr.membership_id=tm.id
      JOIN public.role_permission rp ON rp.tenant_id=mr.tenant_id
        AND rp.role_id=mr.role_id
      WHERE tm.tenant_id=v_invite.tenant_id
        AND tm.user_id=v_invite.invited_by_user_id
        AND tm.status='ACTIVE'
        AND rp.permission_code IN ('*','roles.manage')
        AND rp.scope='all'
    ) OR (
      NOT v_inviter_owner AND EXISTS(
        SELECT 1 FROM public.role_permission target
        WHERE target.tenant_id=v_invite.tenant_id
          AND target.role_id=v_role_id
          AND NOT EXISTS(
            SELECT 1 FROM public.tenant_membership actor
            JOIN public.membership_role amr ON amr.tenant_id=actor.tenant_id
              AND amr.membership_id=actor.id
            JOIN public.role_permission own ON own.tenant_id=amr.tenant_id
              AND own.role_id=amr.role_id
            WHERE actor.tenant_id=v_invite.tenant_id
              AND actor.user_id=v_invite.invited_by_user_id
              AND actor.status='ACTIVE'
              AND own.permission_code IN ('*',target.permission_code)
              AND (CASE own.scope WHEN 'all' THEN 4 WHEN 'branch' THEN 3
                    WHEN 'team' THEN 2 WHEN 'own' THEN 1 ELSE 0 END)
                  >= (CASE target.scope WHEN 'all' THEN 4 WHEN 'branch' THEN 3
                    WHEN 'team' THEN 2 WHEN 'own' THEN 1 ELSE 0 END)
          )
      )
    )
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.tenant_membership(tenant_id,user_id,status,is_owner)
  VALUES (v_invite.tenant_id,p_user_id,'ACTIVE',false)
  ON CONFLICT (tenant_id,user_id)
  DO UPDATE SET status='ACTIVE'
    WHERE tenant_membership.is_owner=false
  RETURNING id INTO v_membership_id;

  IF v_membership_id IS NULL THEN
    RAISE EXCEPTION 'INVITATION_CANNOT_CHANGE_OWNER';
  END IF;

  -- Default VIEWER comes from tenant membership bootstrap trigger.
  DELETE FROM public.membership_role
  WHERE tenant_id=v_invite.tenant_id AND membership_id=v_membership_id;
  INSERT INTO public.membership_role(tenant_id,membership_id,role_id)
  VALUES(v_invite.tenant_id,v_membership_id,v_role_id);

  UPDATE public.tenant_invitation SET status='ACCEPTED',accepted_at=now()
  WHERE id=v_invite.id AND status='PENDING';

  INSERT INTO public.audit_event(
    tenant_id,actor_user_id,actor_membership_id,
    action,resource_type,resource_id,after_data
  ) VALUES (
    v_invite.tenant_id,p_user_id,v_membership_id,
    'membership.accepted','tenant_membership',v_membership_id::text,
    jsonb_build_object('roleCode',v_role_code)
  );

  RETURN QUERY SELECT v_invite.tenant_id,v_membership_id;
END;
$$;

REVOKE ALL ON FUNCTION public.corebiz_auth_accept_invitation(uuid,text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='corebiz_app') THEN
    GRANT EXECUTE ON FUNCTION public.corebiz_auth_accept_invitation(uuid,text) TO corebiz_app;
    GRANT SELECT,INSERT,UPDATE ON tenant_invitation TO corebiz_app;
  END IF;
END $$;
COMMIT;
