BEGIN;

CREATE TABLE billing_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  monthly_price_minor bigint NOT NULL CHECK (monthly_price_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'RUB',
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plan_entitlement (
  plan_id uuid NOT NULL REFERENCES billing_plan(id) ON DELETE CASCADE,
  entitlement_key text NOT NULL,
  entitlement_value jsonb NOT NULL,
  PRIMARY KEY (plan_id, entitlement_key)
);

CREATE TABLE tenant_subscription (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES billing_plan(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'TRIAL'
    CHECK (status IN ('TRIAL','ACTIVE','PAST_DUE','GRACE','READ_ONLY','CANCELLED')),
  current_period_start timestamptz NOT NULL DEFAULT now(),
  current_period_end timestamptz NOT NULL,
  grace_until timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  provider text,
  provider_reference text,
  last_payment_at timestamptz,
  last_payment_minor bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tenant_subscription_status_idx
  ON tenant_subscription(status, current_period_end);

CREATE TABLE billing_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  subscription_status text,
  amount_minor bigint,
  currency char(3),
  provider text,
  provider_reference text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX billing_event_idempotency_uq
  ON billing_event(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE tenant_subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_event ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_subscription_isolation
  ON tenant_subscription
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY billing_event_isolation
  ON billing_event
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

INSERT INTO billing_plan(code, name, monthly_price_minor, currency, sort_order)
VALUES
  ('START', 'Start', 590000, 'RUB', 10),
  ('BUSINESS', 'Business', 1490000, 'RUB', 20),
  ('COMMERCE', 'Commerce', 2990000, 'RUB', 30),
  ('OPERATIONS', 'Operations', 4990000, 'RUB', 40),
  ('ENTERPRISE', 'Enterprise', 12000000, 'RUB', 50)
ON CONFLICT (code) DO NOTHING;

INSERT INTO plan_entitlement(plan_id, entitlement_key, entitlement_value)
SELECT id, 'max_users', to_jsonb(v.max_users)
FROM billing_plan
JOIN (VALUES
  ('START', 5),
  ('BUSINESS', 20),
  ('COMMERCE', 50),
  ('OPERATIONS', 150),
  ('ENTERPRISE', 10000)
) AS v(code, max_users) USING (code)
ON CONFLICT DO NOTHING;

INSERT INTO plan_entitlement(plan_id, entitlement_key, entitlement_value)
SELECT id, 'modules', to_jsonb(v.modules::text[])
FROM billing_plan
JOIN (VALUES
  ('START', ARRAY['crm','tasks','catalog','sales']::text[]),
  ('BUSINESS', ARRAY['crm','tasks','catalog','sales','procurement','inventory','finance']::text[]),
  ('COMMERCE', ARRAY['crm','tasks','catalog','sales','procurement','inventory','finance','migration']::text[]),
  ('OPERATIONS', ARRAY['crm','tasks','catalog','sales','procurement','inventory','finance','migration','advanced_inventory']::text[]),
  ('ENTERPRISE', ARRAY['*']::text[])
) AS v(code, modules) USING (code)
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION corebiz_seed_subscription(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_plan_id uuid;
BEGIN
  SELECT id INTO v_plan_id FROM billing_plan WHERE code = 'START' LIMIT 1;

  INSERT INTO tenant_subscription(
    tenant_id, plan_id, status, current_period_start, current_period_end, grace_until
  )
  VALUES (
    p_tenant_id, v_plan_id, 'TRIAL', now(), now() + interval '14 days',
    now() + interval '21 days'
  )
  ON CONFLICT (tenant_id) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION corebiz_seed_subscription(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION corebiz_tenant_subscription_bootstrap_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM corebiz_seed_subscription(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_seed_subscription
AFTER INSERT ON tenant
FOR EACH ROW
EXECUTE FUNCTION corebiz_tenant_subscription_bootstrap_trigger();

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM corebiz_seed_subscription(t.id);
  END LOOP;
END;
$$;

INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
SELECT r.tenant_id, r.id, 'billing.manage', 'all'
FROM tenant_role r
WHERE r.code = 'ADMIN'
ON CONFLICT DO NOTHING;

COMMIT;
