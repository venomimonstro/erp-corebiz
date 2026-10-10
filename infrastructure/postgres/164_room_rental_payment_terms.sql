BEGIN;

ALTER TABLE room_rental_contract
  ADD COLUMN IF NOT EXISTS payment_term_days integer NOT NULL DEFAULT 5
    CHECK (payment_term_days BETWEEN 0 AND 365);

COMMIT;
