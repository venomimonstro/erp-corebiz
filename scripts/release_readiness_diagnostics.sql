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

-- Dance studio / service-business release invariants.
SELECT 'DANCE_PAST_LESSON_UNCLOSED' AS code,count(*)::bigint AS affected
FROM dance_lesson
WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND ends_at<now()
  AND status IN ('PLANNED','OPEN_FOR_BOOKING','STARTED')
UNION ALL
SELECT 'DANCE_CAPACITY_EXCEEDED',count(*)::bigint
FROM (
  SELECT l.id
  FROM dance_lesson l
  LEFT JOIN dance_lesson_participant p
    ON p.tenant_id=l.tenant_id AND p.lesson_id=l.id
  WHERE l.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
    AND l.status IN ('PLANNED','OPEN_FOR_BOOKING','STARTED')
  GROUP BY l.id,l.capacity
  HAVING count(p.id) FILTER (
    WHERE p.status NOT IN ('WAITLIST','CANCELLED_IN_TIME')
  ) > l.capacity
) q
UNION ALL
SELECT 'DANCE_COMPLETED_WITHOUT_PROFITABILITY',count(*)::bigint
FROM dance_lesson l
WHERE l.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND l.status='COMPLETED'
  AND NOT EXISTS(
    SELECT 1 FROM dance_lesson_profitability p
    WHERE p.tenant_id=l.tenant_id AND p.lesson_id=l.id
  )
UNION ALL
SELECT 'DANCE_TRAINER_ACCRUAL_MISSING',count(*)::bigint
FROM dance_lesson l
WHERE l.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND l.status='COMPLETED'
  AND l.trainer_resource_id IS NOT NULL
  AND EXISTS(
    SELECT 1
    FROM trainer_compensation_plan cp
    WHERE cp.tenant_id=l.tenant_id
      AND cp.trainer_resource_id=l.trainer_resource_id
      AND cp.status='ACTIVE'
      AND cp.valid_from <= l.starts_at::date
      AND (cp.valid_to IS NULL OR cp.valid_to >= l.starts_at::date)
      AND (cp.lesson_type IS NULL OR cp.lesson_type=l.lesson_type)
  )
  AND NOT EXISTS(
    SELECT 1
    FROM trainer_compensation_accrual a
    WHERE a.tenant_id=l.tenant_id AND a.lesson_id=l.id
  )
UNION ALL
SELECT 'DANCE_PACKAGE_COUNTER_DRIFT',count(*)::bigint
FROM service_package sp
WHERE sp.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND (
    sp.reserved_visits <> (
      SELECT count(*) FROM service_package_redemption sr
      WHERE sr.tenant_id=sp.tenant_id
        AND sr.package_id=sp.id
        AND sr.state='RESERVED'
    ) + (
      SELECT count(*) FROM dance_package_redemption dr
      WHERE dr.tenant_id=sp.tenant_id
        AND dr.package_id=sp.id
        AND dr.state='RESERVED'
    )
    OR
    sp.used_visits <> (
      SELECT count(*) FROM service_package_redemption sr
      WHERE sr.tenant_id=sp.tenant_id
        AND sr.package_id=sp.id
        AND sr.state='CONSUMED'
    ) + (
      SELECT count(*) FROM dance_package_redemption dr
      WHERE dr.tenant_id=sp.tenant_id
        AND dr.package_id=sp.id
        AND dr.state='CONSUMED'
    )
  )
UNION ALL
SELECT 'DANCE_ENTITLEMENT_COUNTER_DRIFT',count(*)::bigint
FROM service_package_entitlement e
WHERE e.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND (
    e.reserved_visits <> (
      SELECT count(*) FROM dance_package_redemption dr
      WHERE dr.tenant_id=e.tenant_id
        AND dr.package_entitlement_id=e.id
        AND dr.state='RESERVED'
    )
    OR
    e.used_visits <> (
      SELECT count(*) FROM dance_package_redemption dr
      WHERE dr.tenant_id=e.tenant_id
        AND dr.package_entitlement_id=e.id
        AND dr.state='CONSUMED'
    )
  )
UNION ALL
SELECT 'DANCE_CHARGE_LINK_MISSING',count(*)::bigint
FROM dance_student_charge c
LEFT JOIN financial_obligation o
  ON o.tenant_id=c.tenant_id AND o.id=c.obligation_id
LEFT JOIN finance_invoice i
  ON i.tenant_id=c.tenant_id AND i.id=c.invoice_id
WHERE c.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND c.status<>'CANCELLED'
  AND (
    c.obligation_id IS NULL OR c.invoice_id IS NULL
    OR o.id IS NULL OR i.id IS NULL
    OR o.party_id IS DISTINCT FROM c.payer_party_id
    OR o.amount_minor IS DISTINCT FROM c.amount_minor
    OR i.amount_minor IS DISTINCT FROM c.amount_minor
  )
UNION ALL
SELECT 'PAYMENT_ALLOCATION_SUM_MISMATCH',count(*)::bigint
FROM payment p
WHERE p.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND EXISTS(
    SELECT 1 FROM payment_allocation a
    WHERE a.tenant_id=p.tenant_id AND a.payment_id=p.id
  )
  AND p.amount_minor <> (
    SELECT coalesce(sum(a.amount_minor),0)
    FROM payment_allocation a
    WHERE a.tenant_id=p.tenant_id AND a.payment_id=p.id
  )
UNION ALL
SELECT 'DANCE_ATTENDED_WITHOUT_PAYMENT_SOURCE',count(*)::bigint
FROM dance_lesson_participant p
WHERE p.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND p.status IN ('ATTENDED','LATE')
  AND p.package_id IS NULL
  AND p.price_source='DIRECT'
  AND p.charge_minor=0
UNION ALL
SELECT 'DANCE_PENDING_PACKAGE_WITHOUT_CHARGE',count(*)::bigint
FROM service_package sp
WHERE sp.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND sp.status='PENDING_PAYMENT'
  AND NOT EXISTS(
    SELECT 1 FROM dance_student_charge c
    WHERE c.tenant_id=sp.tenant_id
      AND c.source_type='PACKAGE'
      AND c.source_id=sp.id
      AND c.status<>'CANCELLED'
  )
UNION ALL
SELECT 'DANCE_RENT_STATEMENT_PAYABLE_MISSING',count(*)::bigint
FROM room_rental_statement s
JOIN room_rental_contract c
  ON c.tenant_id=s.tenant_id AND c.id=s.contract_id
WHERE s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND s.status='FINALIZED'
  AND s.amount_minor>0
  AND c.counterparty_party_id IS NOT NULL
  AND (
    s.obligation_id IS NULL
    OR NOT EXISTS(
      SELECT 1 FROM financial_obligation o
      WHERE o.tenant_id=s.tenant_id
        AND o.id=s.obligation_id
        AND o.direction='PAYABLE'
        AND o.source_type='DANCE_ROOM_RENT_STATEMENT'
        AND o.source_id=s.id
    )
  )
UNION ALL
SELECT 'DANCE_RENT_STATEMENT_AMOUNT_MISMATCH',count(*)::bigint
FROM room_rental_statement s
JOIN financial_obligation o
  ON o.tenant_id=s.tenant_id AND o.id=s.obligation_id
WHERE s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND s.status='FINALIZED'
  AND (
    o.direction<>'PAYABLE'
    OR o.source_type<>'DANCE_ROOM_RENT_STATEMENT'
    OR o.source_id<>s.id
    OR o.currency<>s.currency
    OR o.amount_minor<>s.amount_minor
  );
