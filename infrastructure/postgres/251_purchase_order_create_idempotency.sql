BEGIN;
-- Retry-safe user-created purchase orders. Only requests carrying a key use
-- this mechanism; legacy callers remain backward compatible.
ALTER TABLE purchase_order
  ADD COLUMN IF NOT EXISTS create_idempotency_key text,
  ADD COLUMN IF NOT EXISTS create_idempotency_fingerprint text;
CREATE UNIQUE INDEX IF NOT EXISTS purchase_order_create_idem_tenant_actor_key
 ON purchase_order(tenant_id,responsible_membership_id,create_idempotency_key)
 WHERE create_idempotency_key IS NOT NULL;
ALTER TABLE purchase_order
  ADD CONSTRAINT purchase_order_create_idem_pair_chk
  CHECK ((create_idempotency_key IS NULL) =
         (create_idempotency_fingerprint IS NULL));
COMMIT;
