-- Read-only commercial billing gate; run on an explicitly disposable,
-- fully migrated PostgreSQL database as the gate/operator DB role.
-- A missing subscription or paid ACTIVE without verified provider evidence
-- is a release blocker. This gate does not reconcile external PSP data;
-- sandbox and provider checks are still mandatory.
-- Fail instead of silently reading zero rows under a tenant-restricted DB role.
SET row_security = off;
DO $$
DECLARE
  v_missing bigint;
  v_unverified bigint;
BEGIN
  SELECT count(*) INTO v_missing
  FROM tenant t
  LEFT JOIN tenant_subscription s ON s.tenant_id = t.id
  WHERE s.tenant_id IS NULL;

  IF v_missing > 0 THEN
    RAISE EXCEPTION
      'COMMERCIAL_BILLING_NO_SUBSCRIPTION: % tenants without subscription',
      v_missing;
  END IF;

  SELECT count(*) INTO v_unverified
  FROM tenant_subscription s
  JOIN billing_plan p ON p.id = s.plan_id
  WHERE s.status = 'ACTIVE'
    AND p.monthly_price_minor > 0
    AND (
      NULLIF(btrim(s.provider), '') IS NULL
      OR NULLIF(btrim(s.provider_reference), '') IS NULL
      OR s.last_payment_at IS NULL
      OR s.last_payment_minor IS NULL
      OR s.last_payment_minor <= 0
    );

  IF v_unverified > 0 THEN
    RAISE EXCEPTION
      'COMMERCIAL_BILLING_UNVERIFIED_PAID_PLAN: % paid ACTIVE subscriptions without provider evidence',
      v_unverified;
  END IF;

  RAISE NOTICE
    'COMMERCIAL_BILLING_INTEGRITY_PASS: all tenants have subscriptions; no unverified paid ACTIVE subscriptions';
END;
$$;
