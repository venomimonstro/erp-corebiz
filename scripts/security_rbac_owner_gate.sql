\set ON_ERROR_STOP on
-- Execute after migrations as a schema auditor on a disposable clone.
-- A runtime role with RLS enabled cannot scan all tenants and must run
-- per-tenant diagnostics using an explicit app.tenant_id instead.
DO $$
DECLARE bad_owner int;
DECLARE bad_membership int;
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE t.tgname='corebiz_owner_membership_role_guard'
      AND c.relname='membership_role' AND t.tgenabled<>'D'
  ) THEN
    RAISE EXCEPTION 'RBAC_GATE_FAIL: membership OWNER trigger missing or disabled';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE t.tgname='corebiz_owner_flag_change_guard'
      AND c.relname='tenant_membership' AND t.tgenabled<>'D'
  ) THEN
    RAISE EXCEPTION 'RBAC_GATE_FAIL: ownership flag trigger missing or disabled';
  END IF;
  SELECT count(*) INTO bad_owner
  FROM membership_role mr
  JOIN tenant_role r ON r.id=mr.role_id AND r.tenant_id=mr.tenant_id
  JOIN tenant_membership tm ON tm.id=mr.membership_id AND tm.tenant_id=mr.tenant_id
  WHERE r.code='OWNER' AND NOT tm.is_owner;
  IF bad_owner>0 THEN
    RAISE EXCEPTION 'RBAC_GATE_FAIL: % non-owners assigned OWNER role',bad_owner;
  END IF;
  SELECT count(*) INTO bad_membership
  FROM membership_role mr
  JOIN tenant_membership tm ON tm.id=mr.membership_id AND tm.tenant_id=mr.tenant_id
  JOIN tenant_role r ON r.id=mr.role_id AND r.tenant_id=mr.tenant_id
  WHERE tm.is_owner AND r.code='OWNER' AND tm.status<>'ACTIVE';
  IF bad_membership>0 THEN
    RAISE EXCEPTION 'RBAC_GATE_FAIL: % inactive members hold OWNER role',bad_membership;
  END IF;
  RAISE NOTICE 'RBAC_GATE_PASS: tenant OWNER roles and guard triggers verified';
END
$$;
