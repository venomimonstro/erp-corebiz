BEGIN;
-- Only one active unpaid SaaS intent per tenant and plan. Ended attempts do
-- not block future renewals; concurrent requests cannot create two charges.
CREATE UNIQUE INDEX commerce_payment_active_saas_uq
  ON commerce_payment_intent(tenant_id,plan_id)
  WHERE purpose='SAAS' AND status IN ('NEW','PENDING');

-- Canceled refunds are allowed to be retried with a fresh provider request.
-- Completed/active full refunds remain strictly one per captured payment.
ALTER TABLE commerce_refund
  DROP CONSTRAINT IF EXISTS commerce_refund_tenant_id_intent_id_key;
CREATE UNIQUE INDEX commerce_refund_active_once_uq
  ON commerce_refund(tenant_id,intent_id)
  WHERE status IN ('NEW','PENDING','SUCCEEDED');

COMMIT;
