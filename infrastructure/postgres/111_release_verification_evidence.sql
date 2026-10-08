BEGIN;
CREATE TABLE release_verification_record (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 component_code text NOT NULL CHECK(component_code IN ('ACCOUNTING','BANK','VAT','PAYROLL','ANALYTICS','API')),
 target_version text NOT NULL,
 verification_kind text NOT NULL CHECK(verification_kind IN ('MIGRATIONS','TYPECHECK','INTEGRATION','RESTORE','RECONCILIATION')),
 outcome text NOT NULL CHECK(outcome IN ('PASS','FAIL','BLOCKED')),
 evidence_reference text NOT NULL CHECK(length(btrim(evidence_reference))>0),
 executed_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id),
 executed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE release_verification_record ENABLE ROW LEVEL SECURITY;
CREATE POLICY release_verification_record_isolation ON release_verification_record
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE OR REPLACE FUNCTION corebiz_release_verification_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Release verification evidence is immutable'; END;
$$;
CREATE TRIGGER release_verification_immutable_v1 BEFORE UPDATE OR DELETE ON release_verification_record
FOR EACH ROW EXECUTE FUNCTION corebiz_release_verification_immutable();
COMMIT;