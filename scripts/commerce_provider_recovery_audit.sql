-- CoreBiz: read-only payment / delivery operations audit for ONE TENANT.
-- Run under app.tenant_id scope; do NOT embed SQL with production secrets.
-- Expected: pending/unknown consignments require manual reconciliation.
SELECT state,count(*) AS jobs,
       min(next_attempt_at) AS oldest_due,
       max(attempts) AS max_attempts
FROM commerce_reconcile_task
WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
GROUP BY state ORDER BY state;

SELECT state,count(*) AS shipments,min(created_at) AS oldest,
       max(updated_at) AS last_change
FROM commerce_shipment
WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
GROUP BY state ORDER BY state;

SELECT s.id,s.sales_order_id,s.state,s.provider_number,
       s.last_error_code,s.created_at,s.updated_at
FROM commerce_shipment s
WHERE s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND (s.state IN ('UNKNOWN','SENDING','REJECTED')
       OR (s.state='SUBMITTED' AND s.created_at<now()-interval '2 hours'))
ORDER BY s.created_at DESC LIMIT 100;

SELECT c.provider,c.environment,c.state,c.enabled,c.verified_at,
       count(q.id) FILTER (WHERE q.expires_at>now()) AS live_quotes
FROM commerce_provider_connection c
LEFT JOIN commerce_shipping_quote q
 ON q.tenant_id=c.tenant_id AND q.connection_id=c.id
WHERE c.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
GROUP BY c.id ORDER BY c.provider;
