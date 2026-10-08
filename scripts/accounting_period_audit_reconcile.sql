-- Read-only accounting period audit reconciliation (Sprint 51).
-- A returned row indicates current period state lacks a matching latest audit event.
-- OPEN periods with no history are valid.
WITH latest AS (
 SELECT DISTINCT ON (tenant_id,period_id)
   tenant_id,period_id,from_state,to_state,changed_at
 FROM accounting_period_transition
 ORDER BY tenant_id,period_id,changed_at DESC,id DESC
)
SELECT p.tenant_id,p.id AS period_id,p.state,
       l.from_state,l.to_state,l.changed_at,
       CASE
         WHEN l.period_id IS NULL THEN 'NO_CLOSURE_AUDIT'
         ELSE 'STATE_AUDIT_MISMATCH'
       END AS issue
FROM accounting_period p
LEFT JOIN latest l ON l.tenant_id=p.tenant_id AND l.period_id=p.id
WHERE (p.state<>'OPEN' AND l.period_id IS NULL)
   OR (l.period_id IS NOT NULL AND p.state IS DISTINCT FROM l.to_state)
ORDER BY p.tenant_id,p.id;
