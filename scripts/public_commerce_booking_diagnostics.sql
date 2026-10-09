-- CoreBiz read-only public commerce / booking safety diagnostics.
-- Run on a restored staging copy as an authorized diagnostic role.
-- No rows are inserted, updated, or deleted.

-- 1. A checked out cart must reference a real order.
SELECT
  c.tenant_id,
  c.id AS cart_id,
  c.status,
  c.sales_order_id,
  c.updated_at
FROM storefront_cart c
LEFT JOIN sales_order o
  ON o.tenant_id=c.tenant_id AND o.id=c.sales_order_id
WHERE c.status='CHECKED_OUT'
  AND (c.sales_order_id IS NULL OR o.id IS NULL)
ORDER BY c.updated_at DESC;

-- 2. A cart processing for > 10 minutes needs human investigation.
SELECT
  c.tenant_id,
  c.id AS cart_id,
  c.checkout_started_at,
  c.checkout_party_id,
  c.sales_order_id
FROM storefront_cart c
WHERE c.status='PROCESSING'
  AND c.checkout_started_at < now() - interval '10 minutes'
ORDER BY c.checkout_started_at;

-- 3. Sales orders originating from a cart should share a single stable key.
SELECT
  o.tenant_id,
  o.idempotency_key,
  count(*) AS order_count,
  array_agg(o.id ORDER BY o.created_at) AS order_ids
FROM sales_order o
WHERE o.idempotency_key LIKE 'storefront:cart:%'
GROUP BY o.tenant_id,o.idempotency_key
HAVING count(*) > 1
ORDER BY order_count DESC;

-- 4. Public booking form with no allowed resource cannot offer slots.
SELECT
  f.tenant_id,
  f.site_id,
  f.id AS binding_id,
  f.name,
  f.status,
  f.config->>'serviceId' AS service_id,
  f.config->'resourceIds' AS resource_ids
FROM site_form_binding f
WHERE f.status='ACTIVE'
  AND f.action='BOOKING'
  AND (
    jsonb_typeof(f.config->'resourceIds') IS DISTINCT FROM 'array'
    OR jsonb_array_length(
      CASE
        WHEN jsonb_typeof(f.config->'resourceIds')='array'
        THEN f.config->'resourceIds'
        ELSE '[]'::jsonb
      END
    )=0
  );

-- 5. Failed or abandoned public form processing requires reconciliation,
-- not automated replay that may duplicate Party/Deal/Booking records.
SELECT
  s.tenant_id,
  s.id AS submission_id,
  s.binding_id,
  s.status,
  s.result_type,
  s.result_id,
  s.submitted_at,
  s.last_error
FROM site_submission s
WHERE s.status IN ('FAILED','PROCESSING')
ORDER BY s.submitted_at DESC
LIMIT 200;
