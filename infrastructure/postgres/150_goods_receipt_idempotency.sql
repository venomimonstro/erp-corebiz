BEGIN;

ALTER TABLE goods_receipt
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS idempotency_fingerprint text;

CREATE UNIQUE INDEX IF NOT EXISTS goods_receipt_idempotency_uq
  ON goods_receipt(tenant_id,idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname='goods_receipt_idempotency_fingerprint_ck'
      AND conrelid='goods_receipt'::regclass
  ) THEN
    ALTER TABLE goods_receipt
      ADD CONSTRAINT goods_receipt_idempotency_fingerprint_ck
      CHECK (
        idempotency_fingerprint IS NULL
        OR idempotency_fingerprint ~ '^[0-9a-f]{64}$'
      );
  END IF;
END;
$$;

COMMIT;
