BEGIN;

ALTER TABLE release_verification_record
  DROP CONSTRAINT IF EXISTS release_verification_record_verification_kind_check;

ALTER TABLE release_verification_record
  ADD CONSTRAINT release_verification_record_verification_kind_check
  CHECK(verification_kind IN (
    'MIGRATIONS','TYPECHECK','TESTS','BUILD','SECURITY',
    'STABILITY','PERFORMANCE','INTEGRATION','BROWSER_SMOKE',
    'RESTORE','RECONCILIATION'
  ));

COMMIT;
