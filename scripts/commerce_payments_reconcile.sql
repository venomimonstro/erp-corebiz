-- Read-only tenant-specific payment and fiscal reconciliation.
-- Run in a transaction with SET LOCAL app.tenant_id to a disposable tenant.
-- It never posts or refunds real money.
DO $$
DECLARE v_tenant uuid;
BEGIN
  v_tenant:=nullif(current_setting('app.tenant_id',true),'')::uuid;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'BLOCKED: set app.tenant_id to a staging tenant';
  END IF;

  IF EXISTS(
    SELECT 1 FROM commerce_payment_intent i
    LEFT JOIN payment p ON p.tenant_id=i.tenant_id AND p.id=i.finance_payment_id
    WHERE i.tenant_id=v_tenant AND i.purpose='STOREFRONT'
      AND i.status='SUCCEEDED' AND
      (i.finance_payment_id IS NULL OR p.id IS NULL OR p.status<>'POSTED')
  ) THEN
    RAISE EXCEPTION 'BLOCKED: confirmed store payment not reconciled into Finance';
  END IF;

  IF EXISTS(
    SELECT 1 FROM commerce_payment_intent i
    JOIN sales_order o ON o.tenant_id=i.tenant_id AND o.id=i.sales_order_id
    WHERE i.tenant_id=v_tenant AND i.purpose='STOREFRONT'
      AND i.status='SUCCEEDED' AND o.payment_status<>'PAID'
  ) THEN
    RAISE EXCEPTION 'BLOCKED: successful PSP store charge with unpaid Sales order';
  END IF;

  IF EXISTS(
    SELECT 1 FROM commerce_refund r
    LEFT JOIN payment p ON p.tenant_id=r.tenant_id AND p.id=r.finance_payment_id
    WHERE r.tenant_id=v_tenant AND r.status='SUCCEEDED'
      AND (r.finance_payment_id IS NULL OR p.id IS NULL OR
           p.kind<>'REFUND' OR p.direction<>'OUT')
  ) THEN
    RAISE EXCEPTION 'BLOCKED: provider refund not reconciled with immutable ledger';
  END IF;

  IF EXISTS(
    SELECT 1 FROM commerce_merchant_config
    WHERE tenant_id=v_tenant AND enabled AND NOT fiscal_enabled
  ) THEN
    RAISE EXCEPTION 'BLOCKED: acquiring enabled without declared fiscal connection';
  END IF;

  IF EXISTS(
    SELECT 1 FROM commerce_payment_intent
    WHERE tenant_id=v_tenant AND status='SUCCEEDED'
      AND fiscal_status='FAILED'
  ) THEN
    RAISE EXCEPTION 'BLOCKED: completed PSP charge has a failed fiscal receipt';
  END IF;

  RAISE NOTICE 'PASS: store payments/refunds ledgers and fiscal status constraints for tenant %',v_tenant;
END $$;

SELECT
  purpose,status,fiscal_status,count(*)::integer AS operations,
  sum(amount_minor)::text AS amount_minor
FROM commerce_payment_intent
WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
GROUP BY purpose,status,fiscal_status
ORDER BY purpose,status,fiscal_status;

SELECT status,fiscal_status,count(*)::integer AS refunds
FROM commerce_refund
WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
GROUP BY status,fiscal_status
ORDER BY status,fiscal_status;
