BEGIN;

-- Dance portal users are tenant members with a minimal role, not VIEWER.
-- They must never inherit ERP read access or company-wide dance.read.
CREATE OR REPLACE FUNCTION public.corebiz_seed_dance_customer_role(p_tenant_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE v_role uuid;
BEGIN
  INSERT INTO tenant_role(tenant_id,code,name,is_system)
  VALUES(p_tenant_id,'DANCE_CUSTOMER','Клиент студии',true)
  ON CONFLICT(tenant_id,code) DO UPDATE
    SET name=EXCLUDED.name,is_system=true
  RETURNING id INTO v_role;
  INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
  VALUES(p_tenant_id,v_role,'dance.portal.read','own')
  ON CONFLICT(role_id,permission_code) DO UPDATE SET scope='own';
END;
$$;
REVOKE ALL ON FUNCTION public.corebiz_seed_dance_customer_role(uuid) FROM PUBLIC;

DO $$
DECLARE t record;
BEGIN
 FOR t IN SELECT id FROM tenant LOOP
   PERFORM public.corebiz_seed_dance_customer_role(t.id);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.corebiz_tenant_dance_customer_role_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM public.corebiz_seed_dance_customer_role(NEW.id);
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tenant_seed_dance_customer_role ON tenant;
CREATE TRIGGER tenant_seed_dance_customer_role
AFTER INSERT ON tenant FOR EACH ROW
EXECUTE FUNCTION public.corebiz_tenant_dance_customer_role_trigger();

CREATE TABLE IF NOT EXISTS dance_customer_account (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE CASCADE,
 party_id uuid NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
 status text NOT NULL DEFAULT 'ACTIVE'
   CHECK(status IN ('ACTIVE','REVOKED')),
 linked_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,membership_id),
 UNIQUE(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS dance_customer_account_party_idx
 ON dance_customer_account(tenant_id,party_id,status);
ALTER TABLE dance_customer_account ENABLE ROW LEVEL SECURITY;
CREATE POLICY dance_customer_account_isolation
 ON dance_customer_account
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
COMMIT;
