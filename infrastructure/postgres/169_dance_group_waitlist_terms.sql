BEGIN;

ALTER TABLE dance_group_waitlist
  ADD COLUMN IF NOT EXISTS enrollment_status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (enrollment_status IN ('TRIAL','ACTIVE')),
  ADD COLUMN IF NOT EXISTS discount_bps integer NOT NULL DEFAULT 0
    CHECK (discount_bps BETWEEN 0 AND 10000);

COMMIT;
