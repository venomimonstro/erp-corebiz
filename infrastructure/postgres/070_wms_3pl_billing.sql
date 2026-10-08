BEGIN;

CREATE TABLE wms_3pl_rate (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL REFERENCES warehouse_3pl_contract(id) ON DELETE CASCADE,
  service_code text NOT NULL
    CHECK (service_code IN (
      'RECEIPT_UNIT',
      'PUTAWAY_TASK',
      'PICK_TASK',
      'PACK_TASK',
      'SHIPMENT_UNIT',
      'STORAGE_UNIT_DAY'
    )),
  unit text NOT NULL
    CHECK (unit IN ('UNIT','TASK','UNIT_DAY')),
  rate_minor bigint NOT NULL CHECK (rate_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'RUB',
  effective_from date NOT NULL,
  effective_to date,
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX wms_3pl_rate_lookup_idx
  ON wms_3pl_rate(tenant_id,contract_id,service_code,effective_from DESC);

CREATE TABLE wms_3pl_statement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES inventory_owner(id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL REFERENCES warehouse_3pl_contract(id) ON DELETE RESTRICT,
  period_from date NOT NULL,
  period_to date NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','FINALIZED','CANCELLED')),
  currency char(3) NOT NULL DEFAULT 'RUB',
  total_minor bigint NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  generated_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  finalized_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from),
  UNIQUE (contract_id,period_from,period_to)
);

CREATE TABLE wms_3pl_statement_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  statement_id uuid NOT NULL REFERENCES wms_3pl_statement(id) ON DELETE CASCADE,
  service_code text NOT NULL
    CHECK (service_code IN (
      'RECEIPT_UNIT',
      'PUTAWAY_TASK',
      'PICK_TASK',
      'PACK_TASK',
      'SHIPMENT_UNIT',
      'STORAGE_UNIT_DAY'
    )),
  quantity_milli bigint NOT NULL CHECK (quantity_milli >= 0),
  unit text NOT NULL CHECK (unit IN ('UNIT','TASK','UNIT_DAY')),
  rate_minor bigint NOT NULL CHECK (rate_minor >= 0),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  calculation jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (statement_id,service_code)
);

ALTER TABLE wms_3pl_rate ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_3pl_statement ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_3pl_statement_line ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'wms_3pl_rate',
    'wms_3pl_statement',
    'wms_3pl_statement_line'
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

CREATE OR REPLACE FUNCTION corebiz_3pl_statement_line_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM wms_3pl_statement s
    WHERE s.id=OLD.statement_id
      AND s.tenant_id=OLD.tenant_id
      AND s.status='FINALIZED'
  ) THEN
    RAISE EXCEPTION 'Finalized 3PL statement lines are immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN COALESCE(NEW,OLD);
END;
$$;

CREATE TRIGGER wms_3pl_statement_line_guard_v1
BEFORE UPDATE OR DELETE ON wms_3pl_statement_line
FOR EACH ROW EXECUTE FUNCTION corebiz_3pl_statement_line_immutable();

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'wms.3pl_billing.read','all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','FINANCE','WAREHOUSE','VIEWER')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'wms.3pl_billing.manage','all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','FINANCE')
ON CONFLICT DO NOTHING;

COMMIT;
