BEGIN;

ALTER TABLE dance_makeup_credit
  ADD COLUMN IF NOT EXISTS management_value_minor bigint NOT NULL DEFAULT 0
    CHECK (management_value_minor >= 0);

COMMIT;
