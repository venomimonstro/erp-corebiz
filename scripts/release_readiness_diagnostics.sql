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
  AND NOT EXISTS(
    SELECT 1 FROM financial_obligation o
    WHERE o.tenant_id=sp.tenant_id
      AND o.direction='RECEIVABLE'
      AND o.source_type='SALES_ORDER'
      AND o.source_id=sp.sales_order_id
      AND o.status<>'CANCELLED'
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
SELECT 'DANCE_CANCELLED_LESSON_ACTIVE_PARTICIPANT',count(*)::bigint
FROM dance_lesson_participant lp
JOIN dance_lesson l
  ON l.tenant_id=lp.tenant_id AND l.id=lp.lesson_id
WHERE lp.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND l.status IN ('CANCELLED_BY_STUDIO','CANCELLED_BY_TRAINER')
  AND lp.status NOT IN ('CANCELLED_IN_TIME','ATTENDED','LATE')
UNION ALL
SELECT 'DANCE_CANCELLED_LESSON_OPEN_CHARGE',count(*)::bigint
FROM dance_student_charge c
JOIN dance_lesson l
  ON l.tenant_id=c.tenant_id
 AND l.id=c.source_id
 AND c.source_type='LESSON'
WHERE c.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND l.status IN ('CANCELLED_BY_STUDIO','CANCELLED_BY_TRAINER')
  AND c.status IN ('OPEN','PARTIALLY_PAID')
UNION ALL
SELECT 'DANCE_TRAINER_RULE_OVERLAP',count(*)::bigint
FROM trainer_compensation_plan a
JOIN trainer_compensation_plan b
  ON b.tenant_id=a.tenant_id
 AND b.trainer_resource_id=a.trainer_resource_id
 AND b.service_id IS NOT DISTINCT FROM a.service_id
 AND b.lesson_type IS NOT DISTINCT FROM a.lesson_type
 AND b.dance_program_id IS NOT DISTINCT FROM a.dance_program_id
 AND b.dance_group_id IS NOT DISTINCT FROM a.dance_group_id
 AND b.branch_id IS NOT DISTINCT FROM a.branch_id
 AND b.priority=a.priority
 AND b.id>a.id
 AND b.status='ACTIVE'
 AND a.status='ACTIVE'
 AND daterange(a.valid_from,a.valid_to,'[]')
     && daterange(b.valid_from,b.valid_to,'[]')
WHERE a.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
UNION ALL
SELECT 'DANCE_PACKAGE_ENTITLEMENT_DUPLICATE',count(*)::bigint
FROM service_package_plan_entitlement a
JOIN service_package_plan_entitlement b
  ON b.tenant_id=a.tenant_id
 AND b.plan_id=a.plan_id
 AND b.service_id IS NOT DISTINCT FROM a.service_id
 AND b.trainer_resource_id IS NOT DISTINCT FROM a.trainer_resource_id
 AND b.lesson_type IS NOT DISTINCT FROM a.lesson_type
 AND b.dance_program_id IS NOT DISTINCT FROM a.dance_program_id
 AND b.dance_group_id IS NOT DISTINCT FROM a.dance_group_id
 AND b.priority=a.priority
 AND b.id>a.id
 AND b.weekdays && a.weekdays
 AND int4range(b.start_minute::int,b.end_minute::int,'[)')
     && int4range(a.start_minute::int,a.end_minute::int,'[)')
WHERE a.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
UNION ALL
SELECT 'DANCE_ROOM_RENT_CAPACITY_EXCEEDED',count(*)::bigint
FROM room_rental_contract anchor
JOIN service_resource r
  ON r.tenant_id=anchor.tenant_id AND r.id=anchor.room_resource_id
LEFT JOIN service_resource_zone z
  ON z.tenant_id=anchor.tenant_id AND z.id=anchor.zone_id
WHERE anchor.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND anchor.status='ACTIVE'
  AND (
    SELECT coalesce(sum(c.capacity_units),0)
    FROM room_rental_contract c
    WHERE c.tenant_id=anchor.tenant_id
      AND c.room_resource_id=anchor.room_resource_id
      AND c.zone_id IS NOT DISTINCT FROM anchor.zone_id
      AND c.status='ACTIVE'
      AND anchor.valid_from BETWEEN c.valid_from AND coalesce(c.valid_to,'infinity'::date)
  ) > coalesce(z.capacity_units,r.capacity)
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
  )
UNION ALL
SELECT 'SERVICE_DELIVERY_RULE_OVERLAP',count(*)::bigint
FROM service_delivery_rule a
JOIN service_delivery_rule b
  ON b.tenant_id=a.tenant_id
 AND b.service_id=a.service_id
 AND b.delivery_format=a.delivery_format
 AND b.employee_resource_id IS NOT DISTINCT FROM a.employee_resource_id
 AND b.branch_id IS NOT DISTINCT FROM a.branch_id
 AND b.priority=a.priority
 AND b.id>a.id
 AND a.status='ACTIVE'
 AND b.status='ACTIVE'
 AND daterange(a.valid_from,a.valid_to,'[]')
     && daterange(b.valid_from,b.valid_to,'[]')
 AND a.weekdays && b.weekdays
 AND int4range(a.start_minute::int,a.end_minute::int,'[)')
     && int4range(b.start_minute::int,b.end_minute::int,'[)')
WHERE a.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
UNION ALL
SELECT 'SERVICE_ZONE_CAPACITY_EXCEEDED',count(*)::bigint
FROM (
  SELECT z.tenant_id,z.resource_id,sum(z.capacity_units) AS configured,r.capacity
  FROM service_resource_zone z
  JOIN service_resource r
    ON r.tenant_id=z.tenant_id AND r.id=z.resource_id
  WHERE z.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
    AND z.status='ACTIVE'
  GROUP BY z.tenant_id,z.resource_id,r.capacity
  HAVING sum(z.capacity_units)>r.capacity
) q
UNION ALL
SELECT 'TRAINER_PAYROLL_STATEMENT_TOTAL_MISMATCH',count(*)::bigint
FROM trainer_payroll_statement s
WHERE s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND s.total_minor<>(
    s.lesson_accrual_minor+s.base_minor+
    s.guarantee_adjustment_minor+s.adjustment_minor
  )
UNION ALL
SELECT 'TRAINER_PAYROLL_ADJUSTMENT_SUM_MISMATCH',count(*)::bigint
FROM trainer_payroll_statement s
WHERE s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND s.adjustment_minor<>(
    SELECT coalesce(sum(a.amount_minor),0)
    FROM trainer_payroll_adjustment a
    WHERE a.tenant_id=s.tenant_id AND a.statement_id=s.id
  )
UNION ALL
SELECT 'TRAINER_PAYROLL_EXPORTED_WITHOUT_BATCH',count(*)::bigint
FROM trainer_payroll_statement s
WHERE s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND s.status IN ('EXPORTED','PAID')
  AND s.payroll_batch_id IS NULL
UNION ALL
SELECT 'TRAINER_PAYROLL_BATCH_TENANT_MISMATCH',count(*)::bigint
FROM trainer_payroll_statement s
JOIN payroll_accrual_batch b ON b.id=s.payroll_batch_id
WHERE s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND b.tenant_id<>s.tenant_id;

-- Payroll source isolation / trainer salary invariants.
SELECT 'PAYROLL_COMPONENT_AGGREGATE_MISMATCH' AS code,count(*)::bigint AS affected
FROM payroll_accrual_line l
WHERE l.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND (
    l.gross_minor <> (
      SELECT coalesce(sum(c.gross_minor),0)
      FROM payroll_accrual_component c
      WHERE c.tenant_id=l.tenant_id
        AND c.batch_id=l.batch_id
        AND c.employee_ref=l.employee_ref
    )
    OR l.deduction_minor <> (
      SELECT coalesce(sum(c.deduction_minor),0)
      FROM payroll_accrual_component c
      WHERE c.tenant_id=l.tenant_id
        AND c.batch_id=l.batch_id
        AND c.employee_ref=l.employee_ref
    )
  )
UNION ALL
SELECT 'TRAINER_PAYROLL_PROFILE_OVERLAP',count(*)::bigint
FROM trainer_payroll_profile a
JOIN trainer_payroll_profile b
  ON b.tenant_id=a.tenant_id
 AND b.trainer_resource_id=a.trainer_resource_id
 AND b.id>a.id
 AND a.status='ACTIVE'
 AND b.status='ACTIVE'
 AND daterange(a.valid_from,a.valid_to,'[]')
     && daterange(b.valid_from,b.valid_to,'[]')
WHERE a.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
UNION ALL
SELECT 'TRAINER_PAYROLL_STATEMENT_TOTAL_MISMATCH',count(*)::bigint
FROM trainer_payroll_statement s
WHERE s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND s.status<>'CANCELLED'
  AND s.total_minor <>
      s.lesson_accrual_minor+
      s.base_minor+
      s.guarantee_adjustment_minor+
      s.adjustment_minor
UNION ALL
SELECT 'TRAINER_PAYROLL_EXPORTED_SOURCE_MISSING',count(*)::bigint
FROM trainer_payroll_statement s
JOIN service_resource r
  ON r.tenant_id=s.tenant_id AND r.id=s.trainer_resource_id
WHERE s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND s.status IN ('EXPORTED','PAID')
  AND s.payroll_batch_id IS NOT NULL
  AND r.membership_id IS NOT NULL
  AND NOT EXISTS(
    SELECT 1
    FROM payroll_accrual_component c
    WHERE c.tenant_id=s.tenant_id
      AND c.batch_id=s.payroll_batch_id
      AND c.employee_ref=r.membership_id::text
      AND c.source_type='DANCE_TRAINER_STATEMENT'
      AND c.source_key=s.id::text
      AND c.gross_minor=s.total_minor
  );


-- Generic service booking billing invariants.
SELECT 'SERVICE_BOOKING_BILLING_MISSING' AS code,count(*)::bigint AS affected
FROM service_booking b
WHERE b.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND b.party_id IS NOT NULL
  AND b.price_minor_snapshot>0
  AND b.status<>'CANCELLED'
  AND NOT EXISTS(
    SELECT 1
    FROM service_package_redemption r
    WHERE r.tenant_id=b.tenant_id AND r.booking_id=b.id
  )
  AND NOT EXISTS(
    SELECT 1
    FROM service_booking_charge c
    WHERE c.tenant_id=b.tenant_id AND c.booking_id=b.id
  )
UNION ALL
SELECT 'SERVICE_BOOKING_CHARGE_LINK_MISMATCH',count(*)::bigint
FROM service_booking_charge c
JOIN service_booking b
  ON b.tenant_id=c.tenant_id AND b.id=c.booking_id
LEFT JOIN financial_obligation o
  ON o.tenant_id=c.tenant_id AND o.id=c.obligation_id
LEFT JOIN finance_invoice i
  ON i.tenant_id=c.tenant_id AND i.id=c.invoice_id
WHERE c.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND c.status<>'CANCELLED'
  AND (
    c.obligation_id IS NULL
    OR c.invoice_id IS NULL
    OR o.id IS NULL
    OR i.id IS NULL
    OR o.direction<>'RECEIVABLE'
    OR o.source_type<>'SERVICE_BOOKING_CHARGE'
    OR o.source_id<>c.id
    OR o.party_id IS DISTINCT FROM c.payer_party_id
    OR o.amount_minor<>c.amount_minor
    OR o.currency<>c.currency
    OR i.source_type<>'SERVICE_BOOKING_CHARGE'
    OR i.source_id<>c.id
    OR i.party_id<>c.payer_party_id
    OR i.amount_minor<>c.amount_minor
    OR i.currency<>c.currency
  )
UNION ALL
SELECT 'SERVICE_CANCELLED_BOOKING_OPEN_CHARGE',count(*)::bigint
FROM service_booking_charge c
JOIN service_booking b
  ON b.tenant_id=c.tenant_id AND b.id=c.booking_id
LEFT JOIN financial_obligation o
  ON o.tenant_id=c.tenant_id AND o.id=c.obligation_id
WHERE c.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND b.status='CANCELLED'
  AND (
    c.status<>'CANCELLED'
    OR o.status IS DISTINCT FROM 'CANCELLED'
  )
UNION ALL
SELECT 'SERVICE_BOOKING_REFUND_MISSING',count(*)::bigint
FROM service_booking_charge c
JOIN service_booking b
  ON b.tenant_id=c.tenant_id AND b.id=c.booking_id
JOIN financial_obligation o
  ON o.tenant_id=c.tenant_id AND o.id=c.obligation_id
WHERE c.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND b.status='CANCELLED'
  AND o.settled_minor>0
  AND NOT EXISTS(
    SELECT 1
    FROM financial_obligation refund
    WHERE refund.tenant_id=b.tenant_id
      AND refund.direction='PAYABLE'
      AND refund.source_type='SERVICE_BOOKING_REFUND'
      AND refund.source_id=b.id
      AND refund.amount_minor=o.settled_minor
  );


SELECT 'SERVICE_BOOKING_CHARGE_SNAPSHOT_MISMATCH' AS code,count(*)::bigint AS affected
FROM service_booking_charge c
JOIN service_booking b
  ON b.tenant_id=c.tenant_id AND b.id=c.booking_id
WHERE c.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND (
    b.party_id IS DISTINCT FROM c.payer_party_id
    OR b.currency<>c.currency
    OR b.price_minor_snapshot<>c.amount_minor
  )
UNION ALL
SELECT 'SERVICE_BOOKING_CHARGE_PACKAGE_CONFLICT',count(*)::bigint
FROM service_booking_charge c
WHERE c.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND EXISTS(
    SELECT 1
    FROM service_package_redemption r
    WHERE r.tenant_id=c.tenant_id
      AND r.booking_id=c.booking_id
      AND r.state IN ('RESERVED','CONSUMED')
  )
UNION ALL
SELECT 'PAYROLL_PAID_BATCH_STATEMENT_DRIFT',count(*)::bigint
FROM trainer_payroll_statement s
JOIN payroll_accrual_batch b
  ON b.tenant_id=s.tenant_id AND b.id=s.payroll_batch_id
WHERE s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND b.status='PAID'
  AND s.status<>'PAID'
UNION ALL
SELECT 'PAYROLL_PAID_WITHOUT_AUDIT',count(*)::bigint
FROM payroll_accrual_batch b
WHERE b.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND b.status='PAID'
  AND (
    b.paid_at IS NULL
    OR b.paid_by_membership_id IS NULL
  );


SELECT 'DANCE_GROUP_ROOM_ALLOCATION_INVALID' AS code,count(*)::bigint AS affected
FROM dance_group g
LEFT JOIN service_resource r
  ON r.tenant_id=g.tenant_id AND r.id=g.room_resource_id
LEFT JOIN service_resource_zone z
  ON z.tenant_id=g.tenant_id AND z.id=g.room_zone_id
WHERE g.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND g.status<>'ARCHIVED'
  AND (
    (g.room_resource_id IS NULL AND g.room_zone_id IS NOT NULL)
    OR (
      g.room_resource_id IS NOT NULL
      AND (
        r.id IS NULL
        OR r.type NOT IN ('ROOM','HALL','WORKPLACE')
        OR g.room_capacity_units>r.capacity
      )
    )
    OR (
      g.room_zone_id IS NOT NULL
      AND (
        z.id IS NULL
        OR z.resource_id<>g.room_resource_id
        OR z.status<>'ACTIVE'
        OR g.room_capacity_units>z.capacity_units
      )
    )
  );


-- Universal service economics / beauty, barber and nail salary invariants.
SELECT 'SERVICE_COMPLETED_WITHOUT_PROFITABILITY' AS code,count(*)::bigint AS affected
FROM service_booking b
WHERE b.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND b.status='COMPLETED'
  AND NOT EXISTS(
    SELECT 1
    FROM service_booking_profitability p
    WHERE p.tenant_id=b.tenant_id AND p.booking_id=b.id
  )
UNION ALL
SELECT 'SERVICE_PROFITABILITY_FORMULA_MISMATCH',count(*)::bigint
FROM service_booking_profitability p
WHERE p.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND p.contribution_margin_minor<>(
    p.revenue_minor-
    p.material_cost_minor-
    p.employee_cost_minor-
    p.resource_cost_minor-
    p.other_cost_minor
  )
UNION ALL
SELECT 'SERVICE_EMPLOYEE_PLAN_OVERLAP',count(*)::bigint
FROM service_employee_compensation_plan a
JOIN service_employee_compensation_plan b
  ON b.tenant_id=a.tenant_id
 AND b.employee_resource_id=a.employee_resource_id
 AND b.service_id IS NOT DISTINCT FROM a.service_id
 AND b.delivery_format IS NOT DISTINCT FROM a.delivery_format
 AND b.branch_id IS NOT DISTINCT FROM a.branch_id
 AND b.priority=a.priority
 AND b.id>a.id
 AND a.status='ACTIVE'
 AND b.status='ACTIVE'
 AND daterange(a.valid_from,a.valid_to,'[]')
     && daterange(b.valid_from,b.valid_to,'[]')
WHERE a.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
UNION ALL
SELECT 'SERVICE_EMPLOYEE_PROFILE_OVERLAP',count(*)::bigint
FROM service_employee_payroll_profile a
JOIN service_employee_payroll_profile b
  ON b.tenant_id=a.tenant_id
 AND b.employee_resource_id=a.employee_resource_id
 AND b.id>a.id
 AND a.status='ACTIVE'
 AND b.status='ACTIVE'
 AND daterange(a.valid_from,a.valid_to,'[]')
     && daterange(b.valid_from,b.valid_to,'[]')
WHERE a.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
UNION ALL
SELECT 'SERVICE_EMPLOYEE_STATEMENT_TOTAL_MISMATCH',count(*)::bigint
FROM service_employee_payroll_statement st
WHERE st.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND st.status<>'CANCELLED'
  AND st.total_minor<>(
    st.variable_minor+
    st.monthly_base_minor+
    st.daily_base_minor+
    st.guarantee_adjustment_minor+
    st.adjustment_minor
  )
UNION ALL
SELECT 'SERVICE_MATERIAL_CONSUMPTION_OVER_PLAN',count(*)::bigint
FROM service_booking_material m
WHERE m.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND m.consumed_quantity_milli>m.planned_quantity_milli
UNION ALL
SELECT 'SERVICE_EMPLOYEE_ACCRUAL_WITHOUT_PROFITABILITY',count(*)::bigint
FROM service_employee_booking_accrual a
WHERE a.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND NOT EXISTS(
    SELECT 1
    FROM service_booking_profitability p
    WHERE p.tenant_id=a.tenant_id
      AND p.booking_id=a.booking_id
      AND p.employee_resource_id=a.employee_resource_id
  );


-- Service waitlist integrity.
SELECT 'SERVICE_WAITLIST_EXPIRED_OFFER_STUCK' AS code,count(*)::bigint AS affected
FROM service_waitlist_entry w
WHERE w.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND w.status='OFFERED'
  AND w.offer_expires_at<=now()
UNION ALL
SELECT 'SERVICE_WAITLIST_BOOKED_WITHOUT_BOOKING',count(*)::bigint
FROM service_waitlist_entry w
LEFT JOIN service_booking b
  ON b.tenant_id=w.tenant_id AND b.id=w.booked_booking_id
WHERE w.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND w.status='BOOKED'
  AND (
    b.id IS NULL
    OR b.party_id<>w.party_id
    OR b.service_id<>w.service_id
  )
UNION ALL
SELECT 'SERVICE_PAYROLL_EXPORTED_SOURCE_MISSING',count(*)::bigint
FROM service_employee_payroll_statement s
JOIN service_resource r
  ON r.tenant_id=s.tenant_id AND r.id=s.employee_resource_id
WHERE s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND s.status IN ('EXPORTED','PAID')
  AND (
    s.payroll_batch_id IS NULL
    OR NOT EXISTS(
      SELECT 1
      FROM payroll_accrual_component c
      WHERE c.tenant_id=s.tenant_id
        AND c.batch_id=s.payroll_batch_id
        AND c.employee_ref=coalesce(
          r.membership_id::text,
          'service-resource:'||r.id::text
        )
        AND c.source_type='SERVICE_EMPLOYEE_STATEMENT'
        AND c.source_key=s.id::text
        AND c.gross_minor=s.total_minor
    )
  )
UNION ALL
SELECT 'SERVICE_PAYROLL_PAID_BATCH_STATEMENT_DRIFT',count(*)::bigint
FROM service_employee_payroll_statement s
JOIN payroll_accrual_batch b
  ON b.tenant_id=s.tenant_id AND b.id=s.payroll_batch_id
WHERE s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND b.status='PAID'
  AND s.status<>'PAID';

-- Payroll statement acknowledgement / dispute integrity.
SELECT 'PAYROLL_REVIEW_SOURCE_MISMATCH' AS code,count(*)::bigint AS affected
FROM payroll_statement_review pr
LEFT JOIN trainer_payroll_statement dt
  ON pr.statement_kind='DANCE_TRAINER'
 AND dt.tenant_id=pr.tenant_id
 AND dt.id=pr.statement_id
LEFT JOIN service_employee_payroll_statement se
  ON pr.statement_kind='SERVICE_EMPLOYEE'
 AND se.tenant_id=pr.tenant_id
 AND se.id=pr.statement_id
WHERE pr.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND (
    (
      pr.statement_kind='DANCE_TRAINER'
      AND (
        dt.id IS NULL
        OR dt.trainer_resource_id<>pr.employee_resource_id
        OR dt.total_minor<>pr.statement_total_minor_snapshot
        OR dt.currency<>pr.currency
      )
    )
    OR
    (
      pr.statement_kind='SERVICE_EMPLOYEE'
      AND (
        se.id IS NULL
        OR se.employee_resource_id<>pr.employee_resource_id
        OR se.total_minor<>pr.statement_total_minor_snapshot
        OR se.currency<>pr.currency
      )
    )
  )
UNION ALL
SELECT 'PAYROLL_OPEN_DISPUTE_IN_APPROVED_OR_PAID_BATCH',count(*)::bigint
FROM payroll_statement_review pr
WHERE pr.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND pr.review_status='DISPUTED'
  AND (
    (
      pr.statement_kind='DANCE_TRAINER'
      AND EXISTS(
        SELECT 1
        FROM trainer_payroll_statement st
        JOIN payroll_accrual_batch b
          ON b.tenant_id=st.tenant_id AND b.id=st.payroll_batch_id
        WHERE st.tenant_id=pr.tenant_id
          AND st.id=pr.statement_id
          AND b.status IN ('APPROVED','PAID')
      )
    )
    OR
    (
      pr.statement_kind='SERVICE_EMPLOYEE'
      AND EXISTS(
        SELECT 1
        FROM service_employee_payroll_statement st
        JOIN payroll_accrual_batch b
          ON b.tenant_id=st.tenant_id AND b.id=st.payroll_batch_id
        WHERE st.tenant_id=pr.tenant_id
          AND st.id=pr.statement_id
          AND b.status IN ('APPROVED','PAID')
      )
    )
  )
UNION ALL
SELECT 'PAYROLL_REVIEW_RESOLUTION_AUDIT_MISSING',count(*)::bigint
FROM payroll_statement_review pr
WHERE pr.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND pr.review_status IN ('ACKNOWLEDGED','DISPUTED','RESOLVED','WAIVED')
  AND NOT EXISTS(
    SELECT 1
    FROM payroll_statement_review_event e
    WHERE e.tenant_id=pr.tenant_id
      AND e.review_id=pr.id
      AND e.new_status=pr.review_status
  );


-- Russian tax-compliance invariants.
SELECT 'ACCOUNTING_TAX_PROFILE_OVERLAP' AS code,count(*)::bigint AS affected
FROM accounting_tax_profile a
WHERE a.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND a.status='ACTIVE'
  AND EXISTS(
    SELECT 1
    FROM accounting_tax_profile b
    WHERE b.tenant_id=a.tenant_id
      AND b.legal_entity_id=a.legal_entity_id
      AND b.status='ACTIVE'
      AND b.id<>a.id
      AND daterange(
        b.effective_from,coalesce(b.effective_to,'infinity'::date),'[]'
      ) && daterange(
        a.effective_from,coalesce(a.effective_to,'infinity'::date),'[]'
      )
  )
UNION ALL
SELECT 'ACCOUNTING_TAX_OVERDUE_OPEN',count(*)::bigint
FROM accounting_compliance_obligation o
WHERE o.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND o.due_at<now()
  AND o.workflow_status NOT IN ('ACCEPTED','PAID','CANCELLED')
UNION ALL
SELECT 'ACCOUNTING_TAX_SUBMITTED_WITHOUT_RECEIPT',count(*)::bigint
FROM accounting_compliance_obligation o
WHERE o.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND o.workflow_status IN ('ACCEPTED','REJECTED')
  AND NOT EXISTS(
    SELECT 1
    FROM accounting_compliance_receipt r
    WHERE r.tenant_id=o.tenant_id
      AND r.obligation_id=o.id
      AND r.receipt_type IN ('ACCEPTED','REJECTED')
  )
UNION ALL
SELECT 'ACCOUNTING_TAX_PACKET_PROFILE_MISMATCH',count(*)::bigint
FROM accounting_compliance_packet p
JOIN accounting_compliance_obligation o
  ON o.tenant_id=p.tenant_id AND o.id=p.obligation_id
WHERE p.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND p.legal_entity_id<>o.legal_entity_id;


-- Tax calculation / classification integrity.
SELECT 'ACCOUNTING_TAX_CONFIRMED_WITHOUT_AUDIT' AS code,count(*)::bigint AS affected
FROM accounting_tax_calculation c
WHERE c.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND c.status='CONFIRMED'
  AND (
    c.confirmed_by_membership_id IS NULL
    OR c.confirmed_at IS NULL
  )
UNION ALL
SELECT 'ACCOUNTING_TAX_CLASSIFICATION_PAYMENT_MISSING',count(*)::bigint
FROM accounting_tax_payment_classification x
LEFT JOIN payment p
  ON p.tenant_id=x.tenant_id AND p.id=x.payment_id
WHERE x.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND p.id IS NULL
UNION ALL
SELECT 'ACCOUNTING_TAX_AUTO_DEDUCTIBLE_UNSAFE',count(*)::bigint
FROM accounting_tax_payment_classification x
WHERE x.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND x.source='AUTO_RULE'
  AND x.treatment='DEDUCTIBLE_EXPENSE'
UNION ALL
SELECT 'ACCOUNTING_TAX_ADVANCED_STATUS_WITHOUT_APPROVAL',count(*)::bigint
FROM accounting_compliance_obligation o
WHERE o.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND o.workflow_status IN ('APPROVED','SUBMITTED','ACCEPTED','PAID')
  AND (
    o.approved_by_membership_id IS NULL
    OR o.approved_at IS NULL
  )
UNION ALL
SELECT 'ACCOUNTING_TAX_SIGNED_PACKET_WITHOUT_AUDIT',count(*)::bigint
FROM accounting_compliance_packet p
WHERE p.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND p.signature_status='SIGNED'
  AND (
    p.signed_by_membership_id IS NULL
    OR p.signed_at IS NULL
  );


-- Owner accounting / tax ledger integrity.
SELECT 'ACCOUNTING_TAX_LEDGER_PAYMENT_ENTITY_MISMATCH' AS code,count(*)::bigint AS affected
FROM accounting_tax_ledger_item i
JOIN payment p
  ON p.tenant_id=i.tenant_id AND p.id=i.payment_id
JOIN cash_account a
  ON a.tenant_id=p.tenant_id AND a.id=p.cash_account_id
WHERE i.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND a.legal_entity_id IS DISTINCT FROM i.legal_entity_id
UNION ALL
SELECT 'ACCOUNTING_TAX_LEDGER_REVIEW_AUDIT_MISSING',count(*)::bigint
FROM accounting_tax_ledger_item i
WHERE i.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND i.tax_treatment IN ('INCLUDED','EXCLUDED')
  AND i.treatment_reason<>'AUTO_CUSTOMER_PAYMENT'
  AND (
    i.reviewed_by_membership_id IS NULL
    OR i.reviewed_at IS NULL
  )
UNION ALL
SELECT 'ACCOUNTING_SIGNED_PACKET_EVIDENCE_MISSING',count(*)::bigint
FROM accounting_compliance_packet p
WHERE p.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND p.signature_status='SIGNED'
  AND (
    p.signed_by_membership_id IS NULL
    OR p.signed_at IS NULL
    OR nullif(btrim(p.signature_reference),'') IS NULL
    OR nullif(btrim(p.certificate_fingerprint_snapshot),'') IS NULL
  )
UNION ALL
SELECT 'ACCOUNTING_SUBMITTED_WITHOUT_VERIFIED_CONNECTOR',count(*)::bigint
FROM accounting_compliance_obligation o
WHERE o.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND o.workflow_status IN ('SUBMITTED','ACCEPTED')
  AND NOT EXISTS(
    SELECT 1
    FROM accounting_reporting_connector c
    WHERE c.tenant_id=o.tenant_id
      AND c.legal_entity_id=o.legal_entity_id
      AND c.provider=o.external_provider
      AND c.status='VERIFIED'
      AND c.supports_filing=true
  );

-- Structured FNS notification integrity.
SELECT
  'ACCOUNTING_KND1110355_CONFIRMED_LINES_MISSING' AS code,
  count(*)::bigint AS affected
FROM accounting_compliance_obligation o
WHERE o.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND o.form_code='KND_1110355'
  AND o.workflow_status IN ('READY','APPROVED','SUBMITTED','ACCEPTED')
  AND NOT EXISTS(
    SELECT 1
    FROM accounting_compliance_line l
    WHERE l.tenant_id=o.tenant_id
      AND l.obligation_id=o.id
      AND l.status='CONFIRMED'
  )
UNION ALL
SELECT
  'ACCOUNTING_KND1110355_LINE_TOTAL_MISMATCH',
  count(*)::bigint
FROM accounting_compliance_obligation o
WHERE o.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND o.form_code='KND_1110355'
  AND o.amount_minor IS NOT NULL
  AND o.amount_minor<>coalesce((
    SELECT sum(l.amount_minor)
    FROM accounting_compliance_line l
    WHERE l.tenant_id=o.tenant_id
      AND l.obligation_id=o.id
      AND l.status='CONFIRMED'
  ),0)
UNION ALL
SELECT
  'ACCOUNTING_KND1110355_CONFIRMED_LINE_INCOMPLETE',
  count(*)::bigint
FROM accounting_compliance_line l
JOIN accounting_compliance_obligation o
  ON o.tenant_id=l.tenant_id AND o.id=l.obligation_id
JOIN accounting_tax_profile p
  ON p.tenant_id=o.tenant_id AND p.id=o.tax_profile_id
WHERE l.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND o.form_code='KND_1110355'
  AND l.status='CONFIRMED'
  AND (
    nullif(btrim(l.oktmo),'') IS NULL
    OR nullif(btrim(l.kbk),'') IS NULL
    OR nullif(btrim(l.tax_period_code),'') IS NULL
    OR l.reporting_year IS NULL
    OR l.amount_minor IS NULL
    OR (
      p.entity_kind='ORGANIZATION'
      AND nullif(btrim(l.kpp),'') IS NULL
    )
  )
UNION ALL
SELECT
  'ACCOUNTING_FILING_ACCEPTED_WITHOUT_SIGNED_PACKET',
  count(*)::bigint
FROM accounting_compliance_obligation o
LEFT JOIN accounting_compliance_packet p
  ON p.tenant_id=o.tenant_id AND p.id=o.packet_id
WHERE o.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND o.obligation_type IN ('FILE','NOTIFY')
  AND o.workflow_status IN ('SUBMITTED','ACCEPTED')
  AND (
    p.id IS NULL
    OR p.validation_status<>'VALID'
    OR p.signature_status<>'SIGNED'
  );


-- Optional regulated accounting contour must fail closed.
SELECT 'ACCOUNTING_COMPLIANCE_DISABLED_ADVANCED' AS code,count(*)::bigint AS affected
FROM accounting_compliance_obligation o
JOIN accounting_tax_profile p
  ON p.tenant_id=o.tenant_id AND p.id=o.tax_profile_id
WHERE o.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND p.compliance_enabled=false
  AND o.workflow_status NOT IN ('PLANNED','CANCELLED')
UNION ALL
SELECT 'ACCOUNTING_COMPLIANCE_DISABLED_WITHOUT_REASON',count(*)::bigint
FROM accounting_tax_profile p
WHERE p.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND p.status='ACTIVE'
  AND p.compliance_enabled=false
  AND nullif(btrim(p.compliance_disabled_reason),'') IS NULL;

-- Automotive vertical integrity.
SELECT 'AUTOMOTIVE_WORK_ORDER_PARTY_MISMATCH' AS code,count(*)::bigint AS affected
FROM automotive_work_order o
JOIN automotive_vehicle v
  ON v.tenant_id=o.tenant_id AND v.id=o.vehicle_id
WHERE o.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND v.party_id IS NOT NULL
  AND o.party_id IS NOT NULL
  AND v.party_id<>o.party_id
UNION ALL
SELECT 'AUTOMOTIVE_WORK_ORDER_TOTAL_DRIFT',count(*)::bigint
FROM automotive_work_order o
WHERE o.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND (
    o.estimated_total_minor<>coalesce((
      SELECT sum((l.unit_price_minor*l.quantity_milli+999)/1000)
      FROM automotive_work_order_line l
      WHERE l.tenant_id=o.tenant_id
        AND l.work_order_id=o.id
        AND l.approved=true
    ),0)
    OR
    o.actual_total_minor<>coalesce((
      SELECT sum((l.unit_price_minor*l.quantity_milli+999)/1000)
      FROM automotive_work_order_line l
      WHERE l.tenant_id=o.tenant_id
        AND l.work_order_id=o.id
        AND l.approved=true
        AND l.completed=true
    ),0)
  )
UNION ALL
SELECT 'AUTOMOTIVE_DELIVERED_WITH_UNFINISHED_LINE',count(*)::bigint
FROM automotive_work_order o
WHERE o.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND o.status='DELIVERED'
  AND EXISTS(
    SELECT 1
    FROM automotive_work_order_line l
    WHERE l.tenant_id=o.tenant_id
      AND l.work_order_id=o.id
      AND l.approved=true
      AND l.completed=false
  )
UNION ALL
SELECT 'AUTOMOTIVE_DONOR_DISMANTLED_WITHOUT_PARTS',count(*)::bigint
FROM automotive_donor_vehicle d
WHERE d.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND d.status='DISMANTLED'
  AND NOT EXISTS(
    SELECT 1 FROM automotive_dismantled_part p
    WHERE p.tenant_id=d.tenant_id AND p.donor_vehicle_id=d.id
  )
UNION ALL
SELECT 'AUTOMOTIVE_PART_WAREHOUSE_TENANT_DRIFT',count(*)::bigint
FROM automotive_dismantled_part p
LEFT JOIN warehouse w
  ON w.tenant_id=p.tenant_id AND w.id=p.warehouse_id
WHERE p.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND p.warehouse_id IS NOT NULL
  AND w.id IS NULL;


-- Confirmed tax payment tasks must be represented in Finance.
SELECT 'ACCOUNTING_TAX_PAYABLE_MISSING' AS code,count(*)::bigint AS affected
FROM accounting_compliance_obligation o
WHERE o.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND o.obligation_type='PAY'
  AND o.calculation_status='CONFIRMED'
  AND coalesce(o.amount_minor,0)>0
  AND o.workflow_status NOT IN ('CANCELLED')
  AND o.payment_obligation_id IS NULL
UNION ALL
SELECT 'ACCOUNTING_TAX_PAYABLE_AMOUNT_DRIFT',count(*)::bigint
FROM accounting_compliance_obligation o
JOIN financial_obligation f
  ON f.tenant_id=o.tenant_id AND f.id=o.payment_obligation_id
WHERE o.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND o.obligation_type='PAY'
  AND (
    f.direction<>'PAYABLE'
    OR f.source_type<>'ACCOUNTING_COMPLIANCE'
    OR f.source_id<>o.id
    OR f.amount_minor<>coalesce(o.amount_minor,0)
  )
UNION ALL
SELECT 'ACCOUNTING_TAX_PAID_NOT_SETTLED',count(*)::bigint
FROM accounting_compliance_obligation o
LEFT JOIN financial_obligation f
  ON f.tenant_id=o.tenant_id AND f.id=o.payment_obligation_id
WHERE o.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND o.workflow_status='PAID'
  AND (
    f.id IS NULL
    OR f.status<>'SETTLED'
    OR f.settled_minor<>f.amount_minor
  )
UNION ALL
SELECT 'AUTOMOTIVE_PART_PARTIAL_INVENTORY_LINK',count(*)::bigint
FROM automotive_dismantled_part p
WHERE p.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND ((p.sku_id IS NULL)<>(p.warehouse_id IS NULL))
UNION ALL
SELECT 'AUTOMOTIVE_LINKED_PART_WITHOUT_RECEIPT',count(*)::bigint
FROM automotive_dismantled_part p
WHERE p.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND p.sku_id IS NOT NULL
  AND p.warehouse_id IS NOT NULL
  AND NOT EXISTS(
    SELECT 1
    FROM inventory_transaction t
    WHERE t.tenant_id=p.tenant_id
      AND t.source_type='AUTOMOTIVE_DISMANTLED_PART'
      AND t.source_id=p.id
      AND t.movement_type='RECEIPT'
  );
