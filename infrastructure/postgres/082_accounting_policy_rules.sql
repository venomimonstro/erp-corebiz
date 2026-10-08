-- Sprint 51c: versioned accounting policy/rule registry.
-- No rule becomes executable merely by inserting a row.
BEGIN;
CREATE TABLE accounting_policy (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 legal_entity_id uuid NOT NULL REFERENCES legal_entity(id) ON DELETE RESTRICT,
 version integer NOT NULL CHECK(version>0),
 valid_from date NOT NULL,
 valid_to date,
 tax_regime text NOT NULL CHECK(tax_regime IN ('USN','OSNO','OTHER')),
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPROVED','RETIRED')),
 approved_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE RESTRICT,
 approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(valid_to IS NULL OR valid_to>=valid_from),
 CHECK((status='DRAFT') OR (approved_by_membership_id IS NOT NULL AND approved_at IS NOT NULL)),
 UNIQUE(tenant_id,legal_entity_id,version)
);
CREATE TABLE accounting_posting_rule (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 policy_id uuid NOT NULL REFERENCES accounting_policy(id) ON DELETE RESTRICT,
 code text NOT NULL CHECK(length(btrim(code))>0),
 version integer NOT NULL CHECK(version>0),
 source_type text NOT NULL,
 debit_account_id uuid NOT NULL,
 credit_account_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPROVED','RETIRED')),
 valid_from date NOT NULL,
 valid_to date,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(valid_to IS NULL OR valid_to>=valid_from),
 CHECK(debit_account_id<>credit_account_id),
 FOREIGN KEY (tenant_id,debit_account_id) REFERENCES accounting_account(tenant_id,id),
 FOREIGN KEY (tenant_id,credit_account_id) REFERENCES accounting_account(tenant_id,id),
 UNIQUE(tenant_id,policy_id,code,version)
);
CREATE OR REPLACE FUNCTION corebiz_validate_accounting_policy()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM legal_entity l WHERE l.id=NEW.legal_entity_id AND l.tenant_id=NEW.tenant_id)
 THEN RAISE EXCEPTION 'Accounting policy legal entity tenant mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;$$;
CREATE OR REPLACE FUNCTION corebiz_validate_accounting_posting_rule()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM accounting_policy p WHERE p.id=NEW.policy_id AND p.tenant_id=NEW.tenant_id)
 THEN RAISE EXCEPTION 'Posting rule policy tenant mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER accounting_policy_validate_v1 BEFORE INSERT OR UPDATE ON accounting_policy
 FOR EACH ROW EXECUTE FUNCTION corebiz_validate_accounting_policy();
CREATE TRIGGER accounting_posting_rule_validate_v1 BEFORE INSERT OR UPDATE ON accounting_posting_rule
 FOR EACH ROW EXECUTE FUNCTION corebiz_validate_accounting_posting_rule();
ALTER TABLE accounting_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_posting_rule ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounting_policy_isolation ON accounting_policy
 USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY accounting_posting_rule_isolation ON accounting_posting_rule
 USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
COMMIT;
