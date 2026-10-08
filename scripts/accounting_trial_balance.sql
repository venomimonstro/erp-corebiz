-- Sprint 51b: read-only general ledger by tenant / legal entity / period.
-- Run with app.tenant_id set and bind :legal_entity_id and :date_from/:date_to in a SQL client.
-- This diagnostic uses paired debit/credit entries only; it is not statutory reporting.
WITH lines AS (
 SELECT tenant_id,legal_entity_id,business_date,debit_account_id AS account_id,
        amount_minor AS debit_minor,0::bigint AS credit_minor
 FROM accounting_journal_entry
 UNION ALL
 SELECT tenant_id,legal_entity_id,business_date,credit_account_id AS account_id,
        0::bigint AS debit_minor,amount_minor AS credit_minor
 FROM accounting_journal_entry
)
SELECT l.legal_entity_id,a.code,a.name,
       sum(l.debit_minor)::bigint AS debit_turnover_minor,
       sum(l.credit_minor)::bigint AS credit_turnover_minor,
       (sum(l.debit_minor)-sum(l.credit_minor))::bigint AS net_debit_minor
FROM lines l JOIN accounting_account a
 ON a.tenant_id=l.tenant_id AND a.id=l.account_id
WHERE l.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
GROUP BY l.legal_entity_id,a.code,a.name
ORDER BY l.legal_entity_id,a.code;
