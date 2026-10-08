-- Manual pre-release diagnostic: zero rows does not imply overall release approval.
SELECT 'BANK_UNMATCHED' AS check_code, count(*)::bigint AS remaining
 FROM finance_bank_statement_line WHERE payment_id IS NULL
 AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
UNION ALL
SELECT 'VAT_APPROVED_UNREGISTERED',count(*)::bigint
 FROM accounting_vat_document d WHERE d.status='APPROVED'
 AND d.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
 AND NOT EXISTS(SELECT 1 FROM accounting_vat_register r WHERE r.vat_document_id=d.id AND r.tenant_id=d.tenant_id)
UNION ALL
SELECT 'PAYROLL_DRAFT',count(*)::bigint
 FROM payroll_accrual_batch WHERE status='DRAFT'
 AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
UNION ALL
SELECT 'MONTH_CLOSE_INCOMPLETE',count(*)::bigint
 FROM accounting_period p WHERE p.state='OPEN'
 AND p.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
 AND (SELECT count(*) FROM accounting_month_close_check c
 WHERE c.period_id=p.id AND c.tenant_id=p.tenant_id AND c.status='DONE')<>7;