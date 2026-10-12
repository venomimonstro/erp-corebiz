-- Read-only per-tenant fiscal report reconciliation dashboard.
-- Execute with app.tenant_id scoped to the requested tenant.
SELECT d.operation,d.state,count(*) AS documents,
       min(d.created_at) AS oldest_document,
       max(d.updated_at) AS last_update
FROM commerce_fiscal_document d
WHERE d.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
GROUP BY d.operation,d.state ORDER BY d.operation,d.state;

SELECT q.state,count(*) AS tasks,min(q.next_attempt_at) AS oldest_next_run,
       max(q.attempts) AS max_attempts
FROM commerce_fiscal_reconcile_task q
WHERE q.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
GROUP BY q.state ORDER BY q.state;

SELECT d.id,d.site_id,d.payment_intent_id,d.operation,d.state,
       d.external_id,d.provider_uuid,d.last_error_code,
       d.created_at,d.updated_at
FROM commerce_fiscal_document d
WHERE d.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND (d.state IN ('UNKNOWN','FAIL')
       OR (d.state IN ('WAIT','SENDING') AND
           d.updated_at<now()-interval '20 minutes'))
ORDER BY d.created_at LIMIT 100;

SELECT d.id,d.operation,d.external_id,q.attempts,q.next_attempt_at,
       q.state,q.last_error_code
FROM commerce_fiscal_reconcile_task q
JOIN commerce_fiscal_document d
  ON d.tenant_id=q.tenant_id AND d.id=q.document_id
WHERE q.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND q.state='EXHAUSTED'
ORDER BY q.updated_at DESC LIMIT 100;
