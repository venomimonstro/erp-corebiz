-- Read-only blocker gate on an authorized DISPOSABLE restored database.
-- All counts exclude fresh in-flight requests (<15 minutes).
-- Never run as an API user with tenant-scoped RLS: it must examine the
-- restored cross-tenant release data with explicit operator authorization.
DO $audit$
DECLARE
  cross_carrier bigint;
  pending_carrier bigint;
  lost_payment bigint;
  orphan_checkout bigint;
  exhausted_payment bigint;
  exhausted_fiscal bigint;
BEGIN
  SELECT count(*) INTO cross_carrier
  FROM commerce_shipment c JOIN commerce_post_shipment p
    ON p.tenant_id=c.tenant_id AND p.sales_order_id=c.sales_order_id;
  SELECT count(*) INTO pending_carrier FROM (
    SELECT id FROM commerce_shipment
     WHERE state IN ('SENDING','UNKNOWN')
       AND updated_at < now() - interval '15 minutes'
    UNION ALL
    SELECT id FROM commerce_post_shipment
     WHERE state IN ('SENDING','UNKNOWN')
       AND updated_at < now() - interval '15 minutes'
  ) t;
  SELECT count(*) INTO lost_payment FROM commerce_payment_intent
   WHERE purpose='STOREFRONT' AND status='SUCCEEDED'
     AND finance_payment_id IS NULL
     AND updated_at < now() - interval '15 minutes';
  SELECT count(*) INTO orphan_checkout
  FROM storefront_cart c JOIN sales_order o
    ON o.tenant_id=c.tenant_id AND o.id=c.sales_order_id
  LEFT JOIN commerce_order_delivery d
    ON d.tenant_id=c.tenant_id AND d.sales_order_id=o.id
  WHERE c.status='CHECKED_OUT' AND d.sales_order_id IS NULL
    AND c.updated_at < now()-interval '15 minutes';
  SELECT count(*) INTO exhausted_payment
    FROM commerce_reconcile_task WHERE state='EXHAUSTED';
  SELECT count(*) INTO exhausted_fiscal
    FROM commerce_fiscal_reconcile_task WHERE state='EXHAUSTED';
  RAISE NOTICE
    'commerce gate: cross_carrier %, unresolved_carrier %, lost_payment %, no_delivery %, exhausted_psp %, exhausted_fiscal %',
    cross_carrier,pending_carrier,lost_payment,orphan_checkout,
    exhausted_payment,exhausted_fiscal;
  IF cross_carrier+pending_carrier+lost_payment+orphan_checkout+
     exhausted_payment+exhausted_fiscal > 0 THEN
    RAISE EXCEPTION
      'COREBIZ_COMMERCE_INTEGRITY_BLOCKED: reconcile pending claims, payments and missing delivery before releasing';
  END IF;
END $audit$;
