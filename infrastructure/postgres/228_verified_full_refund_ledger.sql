BEGIN;
CREATE TABLE commerce_refund(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  intent_id uuid NOT NULL REFERENCES commerce_payment_intent(id) ON DELETE RESTRICT,
  sales_order_id uuid NOT NULL REFERENCES sales_order(id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  provider_refund_id text UNIQUE,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'NEW'
    CHECK(status IN ('NEW','PENDING','SUCCEEDED','CANCELED')),
  fiscal_status text NOT NULL DEFAULT 'PENDING'
    CHECK(fiscal_status IN ('PENDING','SUCCEEDED','FAILED')),
  finance_payment_id uuid REFERENCES payment(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,intent_id)
);
ALTER TABLE commerce_refund ENABLE ROW LEVEL SECURITY;
CREATE POLICY commerce_refund_isolation ON commerce_refund
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE FUNCTION corebiz_resolve_refund_tenant(p_provider_refund_id text)
RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $$
  SELECT tenant_id FROM commerce_refund WHERE provider_refund_id=p_provider_refund_id LIMIT 1;
$$;
REVOKE ALL ON FUNCTION corebiz_resolve_refund_tenant(text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='corebiz_app') THEN
    GRANT EXECUTE ON FUNCTION corebiz_resolve_refund_tenant(text) TO corebiz_app;
  END IF;
END $$;
COMMIT;
