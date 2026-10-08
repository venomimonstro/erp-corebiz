BEGIN;
ALTER TABLE site_submission DROP CONSTRAINT IF EXISTS site_submission_status_check;
ALTER TABLE site_submission ADD CONSTRAINT site_submission_status_check
 CHECK(status IN ('RECEIVED','PROCESSING','PROCESSED','FAILED','REJECTED'));
COMMIT;