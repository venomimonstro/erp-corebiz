BEGIN;

-- RBAC isolation defence in depth: even a direct write through a compromised
-- API cannot make a non-owner the tenant OWNER by assigning a role row.
CREATE OR REPLACE FUNCTION corebiz_guard_owner_membership_role()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v_code text;
DECLARE v_owner boolean;
BEGIN
  SELECT code INTO v_code FROM tenant_role
    WHERE tenant_id=NEW.tenant_id AND id=NEW.role_id;
  IF v_code='OWNER' THEN
    SELECT is_owner INTO v_owner
    FROM tenant_membership
    WHERE tenant_id=NEW.tenant_id AND id=NEW.membership_id;
    IF v_owner IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'OWNER role requires verified ownership membership'
        USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END;$$;

CREATE TRIGGER corebiz_owner_membership_role_guard
  BEFORE INSERT OR UPDATE OF tenant_id,membership_id,role_id
  ON membership_role
  FOR EACH ROW EXECUTE FUNCTION corebiz_guard_owner_membership_role();

-- Prevent changing an already assigned role into OWNER through the role table.
CREATE OR REPLACE FUNCTION corebiz_guard_owner_role_code()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.code='OWNER' AND OLD.code IS DISTINCT FROM 'OWNER' AND EXISTS (
    SELECT 1 FROM membership_role mr
    JOIN tenant_membership m ON m.tenant_id=mr.tenant_id
      AND m.id=mr.membership_id
    WHERE mr.tenant_id=NEW.tenant_id AND mr.role_id=NEW.id
      AND NOT m.is_owner
  ) THEN
    RAISE EXCEPTION 'Cannot rename assigned role to OWNER'
      USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;$$;

CREATE TRIGGER corebiz_owner_role_code_guard
  BEFORE UPDATE OF code ON tenant_role
  FOR EACH ROW EXECUTE FUNCTION corebiz_guard_owner_role_code();

-- Existing improper OWNER-role assignments are revoked; membership.is_owner
-- remains the authoritative ownership flag.
DELETE FROM membership_role mr USING tenant_role r,tenant_membership m
WHERE mr.tenant_id=r.tenant_id AND mr.role_id=r.id
  AND m.tenant_id=mr.tenant_id AND m.id=mr.membership_id
  AND r.code='OWNER' AND NOT m.is_owner;

-- Guard ownership flag changes, too: a demoted member may not retain OWNER.
CREATE OR REPLACE FUNCTION corebiz_guard_owner_flag_change()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF OLD.is_owner AND NOT NEW.is_owner AND EXISTS (
    SELECT 1 FROM membership_role mr
    JOIN tenant_role r ON r.tenant_id=mr.tenant_id
      AND r.id=mr.role_id
    WHERE mr.tenant_id=NEW.tenant_id AND mr.membership_id=NEW.id
      AND r.code='OWNER'
  ) THEN
    RAISE EXCEPTION 'Revoke owner role before ownership transfer'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER corebiz_owner_flag_change_guard
  BEFORE UPDATE OF is_owner ON tenant_membership
  FOR EACH ROW EXECUTE FUNCTION corebiz_guard_owner_flag_change();

COMMIT;