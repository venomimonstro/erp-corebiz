BEGIN;

CREATE TABLE room_rental_statement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL REFERENCES room_rental_contract(id) ON DELETE RESTRICT,
  period_from date NOT NULL,
  period_to date NOT NULL,
  currency char(3) NOT NULL DEFAULT 'RUB',
  amount_minor bigint NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  lesson_count integer NOT NULL DEFAULT 0 CHECK (lesson_count >= 0),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','FINALIZED','CANCELLED')),
  obligation_id uuid REFERENCES financial_obligation(id) ON DELETE RESTRICT,
  calculation_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  finalized_at timestamptz,
  finalized_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from),
  UNIQUE (tenant_id,contract_id,period_from,period_to),
  UNIQUE (tenant_id,id)
);

CREATE INDEX room_rental_statement_period_idx
  ON room_rental_statement(tenant_id,period_from,period_to,status);

ALTER TABLE room_rental_statement ENABLE ROW LEVEL SECURITY;
CREATE POLICY room_rental_statement_isolation
  ON room_rental_statement
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

DROP TRIGGER IF EXISTS room_rental_statement_tenant_refs_v1
  ON room_rental_statement;
CREATE TRIGGER room_rental_statement_tenant_refs_v1
BEFORE INSERT OR UPDATE ON room_rental_statement
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'contract_id','room_rental_contract',
  'obligation_id','financial_obligation'
);

COMMIT;
