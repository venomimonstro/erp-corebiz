-- Read-only bank reconciliation diagnostics, scoped to active tenant.
SELECT s.id AS statement_id,s.status,s.external_statement_id,
       count(l.id)::bigint AS imported_lines,
       count(l.id) FILTER (WHERE l.payment_id IS NULL)::bigint AS unmatched_lines,
       coalesce(sum(CASE WHEN l.direction='IN' THEN l.amount_minor ELSE -l.amount_minor END),0)::bigint AS bank_net_minor,
       coalesce(sum(CASE WHEN l.payment_id IS NOT NULL AND p.direction='IN' THEN p.amount_minor
                         WHEN l.payment_id IS NOT NULL THEN -p.amount_minor ELSE 0 END),0)::bigint AS matched_net_minor
FROM finance_bank_statement s
LEFT JOIN finance_bank_statement_line l
 ON l.tenant_id=s.tenant_id AND l.statement_id=s.id
LEFT JOIN payment p ON p.tenant_id=l.tenant_id AND p.id=l.payment_id
WHERE s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
GROUP BY s.id
ORDER BY s.imported_at DESC;
