BEGIN;

-- One canonical commercial-operability predicate for every tenant-facing
-- public surface and background integration. Authenticated ERP writes are
-- still guarded by SubscriptionGuard; this function closes the gap for
-- public storefronts/forms/webhooks and workers that do not carry a user
-- session. Operator suspension always wins. A missing subscription fails
-- closed. Grace follows the same semantics as BillingService.evaluate().
CREATE OR REPLACE FUNCTION public.corebiz_tenant_is_operational(
  p_tenant_id uuid
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.tenant t
    JOIN public.tenant_subscription s ON s.tenant_id=t.id
    WHERE t.id=p_tenant_id
      AND t.status NOT IN ('SUSPENDED','CANCELLED')
      AND s.status NOT IN ('SUSPENDED','CANCELLED','READ_ONLY')
      AND (
        (s.status IN ('TRIAL','ACTIVE') AND s.current_period_end>now())
        OR (
          s.grace_until IS NOT NULL
          AND s.grace_until>now()
        )
      )
  );
$$;

REVOKE ALL ON FUNCTION public.corebiz_tenant_is_operational(uuid) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='corebiz_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.corebiz_tenant_is_operational(uuid) TO corebiz_app';
  ELSE
    RAISE WARNING 'corebiz_app does not exist: operability predicate is not granted to runtime role';
  END IF;
END;
$$;

COMMIT;
