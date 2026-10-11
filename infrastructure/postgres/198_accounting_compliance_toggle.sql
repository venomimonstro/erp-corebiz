BEGIN;

ALTER TABLE accounting_tax_profile
  ADD COLUMN IF NOT EXISTS compliance_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS compliance_disabled_reason text,
  ADD COLUMN IF NOT EXISTS compliance_disabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS compliance_disabled_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL;

ALTER TABLE accounting_tax_profile
  DROP CONSTRAINT IF EXISTS accounting_tax_profile_compliance_disabled_reason_ck;

ALTER TABLE accounting_tax_profile
  ADD CONSTRAINT accounting_tax_profile_compliance_disabled_reason_ck
  CHECK (
    compliance_enabled
    OR (
      compliance_disabled_reason IS NOT NULL
      AND length(btrim(compliance_disabled_reason)) BETWEEN 4 AND 500
    )
  );

CREATE OR REPLACE FUNCTION corebiz_accounting_tax_profile_compliance_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NEW.compliance_enabled THEN
    NEW.compliance_disabled_reason:=NULL;
    NEW.compliance_disabled_at:=NULL;
    NEW.compliance_disabled_by_membership_id:=NULL;
  ELSIF TG_OP='INSERT'
     OR OLD.compliance_enabled IS DISTINCT FROM NEW.compliance_enabled THEN
    NEW.compliance_disabled_at:=coalesce(NEW.compliance_disabled_at,now());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounting_tax_profile_compliance_guard_v1
  ON accounting_tax_profile;
CREATE TRIGGER accounting_tax_profile_compliance_guard_v1
BEFORE INSERT OR UPDATE OF
  compliance_enabled,compliance_disabled_reason,
  compliance_disabled_at,compliance_disabled_by_membership_id
ON accounting_tax_profile
FOR EACH ROW EXECUTE FUNCTION corebiz_accounting_tax_profile_compliance_guard();

CREATE OR REPLACE FUNCTION corebiz_accounting_compliance_enabled_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  enabled boolean;
BEGIN
  SELECT p.compliance_enabled
  INTO enabled
  FROM accounting_tax_profile p
  WHERE p.tenant_id=NEW.tenant_id
    AND p.id=NEW.tax_profile_id;

  IF enabled IS FALSE
     AND NEW.workflow_status NOT IN ('CANCELLED','PLANNED') THEN
    RAISE EXCEPTION 'ACCOUNTING_COMPLIANCE_DISABLED'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounting_compliance_enabled_guard_v1
  ON accounting_compliance_obligation;
CREATE TRIGGER accounting_compliance_enabled_guard_v1
BEFORE INSERT OR UPDATE OF workflow_status,tax_profile_id
ON accounting_compliance_obligation
FOR EACH ROW EXECUTE FUNCTION corebiz_accounting_compliance_enabled_guard();

CREATE INDEX IF NOT EXISTS accounting_tax_profile_compliance_idx
  ON accounting_tax_profile(
    tenant_id,legal_entity_id,compliance_enabled,status,effective_from DESC
  );

COMMIT;
