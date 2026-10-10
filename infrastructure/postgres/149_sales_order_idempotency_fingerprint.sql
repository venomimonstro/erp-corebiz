BEGIN;

ALTER TABLE sales_order
  ADD COLUMN IF NOT EXISTS idempotency_fingerprint text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname='sales_order_idempotency_fingerprint_ck'
      AND conrelid='sales_order'::regclass
  ) THEN
    ALTER TABLE sales_order
      ADD CONSTRAINT sales_order_idempotency_fingerprint_ck
      CHECK (
        idempotency_fingerprint IS NULL
        OR idempotency_fingerprint ~ '^[0-9a-f]{64}$'
      );
  END IF;
END;
$$;

COMMIT;
