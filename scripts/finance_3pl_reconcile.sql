-- Sprint 50 diagnostic: read-only reconciliation of 3PL invoices,
-- financial obligations, and associated posted payments.
-- Run with tenant-scoped database session; empty result means no mismatch
-- for the stated checks, not proof of correct bank settlement.
WITH payment_totals AS (
 SELECT tenant_id,obligation_id,
   coalesce(sum(CASE WHEN status='POSTED' AND kind='PAYMENT'
      AND direction='IN' THEN amount_minor
     WHEN status='POSTED' AND kind='REFUND'
      AND direction='OUT' THEN -amount_minor ELSE 0 END),0)::bigint AS net_received
 FROM payment
 WHERE obligation_id IS NOT NULL
 GROUP BY tenant_id,obligation_id
)
SELECT i.tenant_id,i.id AS invoice_id,i.business_number,
       i.status AS invoice_status,o.status AS obligation_status,
       i.amount_minor,o.amount_minor AS obligation_amount_minor,
       o.settled_minor,coalesce(p.net_received,0) AS net_received_minor,
       CASE
         WHEN i.amount_minor <> o.amount_minor THEN 'AMOUNT_MISMATCH'
         WHEN i.currency <> o.currency THEN 'CURRENCY_MISMATCH'
         WHEN i.party_id IS DISTINCT FROM o.party_id THEN 'PARTY_MISMATCH'
         WHEN i.status='PAID' AND o.status<>'SETTLED' THEN 'PAID_STATUS_MISMATCH'
         WHEN i.status='PARTIALLY_PAID' AND o.status<>'PARTIALLY_SETTLED'
           THEN 'PARTIAL_STATUS_MISMATCH'
         WHEN i.status='ISSUED' AND o.status IN ('SETTLED','PARTIALLY_SETTLED')
           THEN 'INVOICE_STATUS_STALE'
         WHEN o.settled_minor <> coalesce(p.net_received,0)
           THEN 'PAYMENT_ALLOCATION_MISMATCH'
       END AS issue
FROM finance_invoice i
JOIN financial_obligation o
 ON o.tenant_id=i.tenant_id AND o.id=i.obligation_id
LEFT JOIN payment_totals p
 ON p.tenant_id=o.tenant_id AND p.obligation_id=o.id
WHERE i.amount_minor<>o.amount_minor OR i.currency<>o.currency
 OR i.party_id IS DISTINCT FROM o.party_id
 OR (i.status='PAID' AND o.status<>'SETTLED')
 OR (i.status='PARTIALLY_PAID' AND o.status<>'PARTIALLY_SETTLED')
 OR (i.status='ISSUED' AND o.status IN ('SETTLED','PARTIALLY_SETTLED'))
 OR o.settled_minor<>coalesce(p.net_received,0)
ORDER BY i.tenant_id,i.business_number;
