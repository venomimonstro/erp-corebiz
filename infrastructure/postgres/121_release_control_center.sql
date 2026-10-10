BEGIN;

ALTER TABLE release_verification_record
  DROP CONSTRAINT IF EXISTS release_verification_record_component_code_check;

ALTER TABLE release_verification_record
  ADD CONSTRAINT release_verification_record_component_code_check
  CHECK(component_code IN (
    'CORE','API','AUTH','COMMERCE','SITES','WMS',
    'FINANCE','BANK','ACCOUNTING','VAT','PAYROLL','ANALYTICS'
  ));

ALTER TABLE release_verification_record
  DROP CONSTRAINT IF EXISTS release_verification_record_verification_kind_check;

ALTER TABLE release_verification_record
  ADD CONSTRAINT release_verification_record_verification_kind_check
  CHECK(verification_kind IN (
    'MIGRATIONS','TYPECHECK','TESTS','BUILD','SECURITY',
    'INTEGRATION','BROWSER_SMOKE','RESTORE','RECONCILIATION'
  ));

CREATE INDEX IF NOT EXISTS release_verification_latest_idx
  ON release_verification_record(
    tenant_id,component_code,verification_kind,executed_at DESC
  );

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'release.read','all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','VIEWER')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'release.manage','all'
FROM tenant_role r
WHERE r.code='ADMIN'
ON CONFLICT DO NOTHING;

COMMIT;
