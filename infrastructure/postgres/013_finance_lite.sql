BEGIN;

CREATE TABLE cash_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'BANK'
    CHECK (kind IN ('BANK','CASH','ACQUIRING','OTHER')),
  currency char(3) NOT NULL DEFAULT 'RUB',
  opening_balance_minor bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX cash_account_one_default_uq
  ON cash_account(tenant_id, currency)
  WHERE is_default = true AND status = 'ACTIVE';

CREATE TABLE cash_flow_category (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('IN','OUT','BOTH')),
  code text,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name, direction)
);

CREATE TABLE financial_obligation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('RECEIVABLE','PAYABLE')),
  party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  currency char(3) NOT NULL DEFAULT 'RUB',
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  settled_minor bigint NOT NULL DEFAULT 0 CHECK (settled_minor >= 0),
  due_at timestamptz,
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','PARTIALLY_SETTLED','SETTLED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, direction, source_type, source_id),
  CHECK (settled_minor <= amount_minor)
);

CREATE INDEX financial_obligation_open_idx
  ON financial_obligation(tenant_id, direction, status, due_at);

CREATE TABLE payment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  business_number text NOT NULL,
  cash_account_id uuid NOT NULL REFERENCES cash_account(id) ON DELETE RESTRICT,
  category_id uuid REFERENCES cash_flow_category(id) ON DELETE SET NULL,
  party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  obligation_id uuid REFERENCES financial_obligation(id) ON DELETE SET NULL,
  direction text NOT NULL CHECK (direction IN ('IN','OUT')),
  kind text NOT NULL DEFAULT 'PAYMENT'
    CHECK (kind IN ('PAYMENT','REFUND')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'RUB',
  status text NOT NULL DEFAULT 'POSTED'
    CHECK (status IN ('POSTED','REVERSED')),
  source_type text,
  source_id uuid,
  idempotency_key text,
  note text,
  posted_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  posted_at timestamptz NOT NULL DEFAULT now(),
  reversed_at timestamptz,
  reversal_of_payment_id uuid REFERENCES payment(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, business_number)
);

CREATE UNIQUE INDEX payment_idempotency_uq
  ON payment(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX payment_account_idx
  ON payment(tenant_id, cash_account_id, posted_at DESC);

CREATE INDEX payment_source_idx
  ON payment(tenant_id, source_type, source_id);

ALTER TABLE cash_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_flow_category ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_obligation ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'cash_account','cash_flow_category','financial_obligation','payment'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      tbl || '_isolation',
      tbl
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION corebiz_payment_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment is immutable';
  END IF;

  IF OLD.business_number <> NEW.business_number
     OR OLD.cash_account_id <> NEW.cash_account_id
     OR OLD.direction <> NEW.direction
     OR OLD.kind <> NEW.kind
     OR OLD.amount_minor <> NEW.amount_minor
     OR OLD.currency <> NEW.currency
     OR OLD.party_id IS DISTINCT FROM NEW.party_id
     OR OLD.obligation_id IS DISTINCT FROM NEW.obligation_id
     OR OLD.source_type IS DISTINCT FROM NEW.source_type
     OR OLD.source_id IS DISTINCT FROM NEW.source_id
  THEN
    RAISE EXCEPTION 'posted payment financial fields are immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_immutable_guard
BEFORE UPDATE OR DELETE ON payment
FOR EACH ROW
EXECUTE FUNCTION corebiz_payment_immutable();

CREATE OR REPLACE FUNCTION corebiz_seed_finance(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO cash_account(tenant_id, name, kind, currency, is_default)
  VALUES (p_tenant_id, 'Основной счёт', 'BANK', 'RUB', true)
  ON CONFLICT DO NOTHING;

  INSERT INTO cash_flow_category(tenant_id, name, direction, code)
  VALUES
    (p_tenant_id, 'Оплата от клиентов', 'IN', 'CUSTOMER_PAYMENT'),
    (p_tenant_id, 'Возврат клиенту', 'OUT', 'CUSTOMER_REFUND'),
    (p_tenant_id, 'Оплата поставщикам', 'OUT', 'SUPPLIER_PAYMENT'),
    (p_tenant_id, 'Возврат от поставщика', 'IN', 'SUPPLIER_REFUND'),
    (p_tenant_id, 'Прочие поступления', 'IN', 'OTHER_IN'),
    (p_tenant_id, 'Прочие расходы', 'OUT', 'OTHER_OUT')
  ON CONFLICT DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION corebiz_seed_finance(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION corebiz_tenant_finance_bootstrap_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM corebiz_seed_finance(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_seed_finance
AFTER INSERT ON tenant
FOR EACH ROW
EXECUTE FUNCTION corebiz_tenant_finance_bootstrap_trigger();

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM corebiz_seed_finance(t.id);
  END LOOP;
END;
$$;

INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
SELECT r.tenant_id, r.id, 'finance.read', 'all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','FINANCE','VIEWER')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
SELECT r.tenant_id, r.id, 'finance.write', 'all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','FINANCE')
ON CONFLICT DO NOTHING;

COMMIT;
