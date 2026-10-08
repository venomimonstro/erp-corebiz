BEGIN;

CREATE TABLE finance_invoice (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  business_number text NOT NULL,
  party_id uuid NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  source_type text NOT NULL
    CHECK (source_type IN ('WMS_3PL_STATEMENT')),
  source_id uuid NOT NULL,
  obligation_id uuid NOT NULL REFERENCES financial_obligation(id) ON DELETE RESTRICT,
  period_from date,
  period_to date,
  currency char(3) NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  status text NOT NULL DEFAULT 'ISSUED'
    CHECK (status IN (
      'ISSUED','PARTIALLY_PAID','PAID','CANCELLED','CREDITED'
    )),
  issued_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz,
  cancelled_at timestamptz,
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,business_number),
  UNIQUE (tenant_id,source_type,source_id)
);

CREATE INDEX finance_invoice_party_idx
  ON finance_invoice(tenant_id,party_id,status,due_at,issued_at DESC);

ALTER TABLE finance_invoice ENABLE ROW LEVEL SECURITY;

CREATE POLICY finance_invoice_isolation
  ON finance_invoice
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

ALTER TABLE wms_3pl_statement
  ADD COLUMN IF NOT EXISTS finance_invoice_id uuid
  REFERENCES finance_invoice(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS finance_handed_off_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS wms_3pl_statement_finance_invoice_uq
  ON wms_3pl_statement(finance_invoice_id)
  WHERE finance_invoice_id IS NOT NULL;

CREATE OR REPLACE FUNCTION corebiz_validate_finance_invoice()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM financial_obligation o
    WHERE o.id=NEW.obligation_id
      AND o.tenant_id=NEW.tenant_id
      AND o.direction='RECEIVABLE'
      AND o.party_id=NEW.party_id
      AND o.source_type=NEW.source_type
      AND o.source_id=NEW.source_id
      AND o.currency=NEW.currency
      AND o.amount_minor=NEW.amount_minor
  ) THEN
    RAISE EXCEPTION 'Invoice obligation snapshot mismatch'
      USING ERRCODE='23514';
  END IF;

  IF NEW.source_type='WMS_3PL_STATEMENT' AND NOT EXISTS (
    SELECT 1
    FROM wms_3pl_statement s
    JOIN inventory_owner io
      ON io.tenant_id=s.tenant_id
     AND io.id=s.owner_id
    WHERE s.id=NEW.source_id
      AND s.tenant_id=NEW.tenant_id
      AND s.status='FINALIZED'
      AND io.owner_type='CLIENT'
      AND io.party_id=NEW.party_id
      AND s.currency=NEW.currency
      AND s.total_minor=NEW.amount_minor
      AND s.period_from IS NOT DISTINCT FROM NEW.period_from
      AND s.period_to IS NOT DISTINCT FROM NEW.period_to
  ) THEN
    RAISE EXCEPTION 'Invoice 3PL statement snapshot mismatch'
      USING ERRCODE='23514';
  END IF;

  IF TG_OP='UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
    NEW.business_number IS DISTINCT FROM OLD.business_number OR
    NEW.party_id IS DISTINCT FROM OLD.party_id OR
    NEW.source_type IS DISTINCT FROM OLD.source_type OR
    NEW.source_id IS DISTINCT FROM OLD.source_id OR
    NEW.obligation_id IS DISTINCT FROM OLD.obligation_id OR
    NEW.period_from IS DISTINCT FROM OLD.period_from OR
    NEW.period_to IS DISTINCT FROM OLD.period_to OR
    NEW.currency IS DISTINCT FROM OLD.currency OR
    NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
  ) THEN
    RAISE EXCEPTION 'Issued invoice snapshot fields are immutable'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_finance_invoice_v1
BEFORE INSERT OR UPDATE ON finance_invoice
FOR EACH ROW EXECUTE FUNCTION corebiz_validate_finance_invoice();

CREATE OR REPLACE FUNCTION corebiz_sync_invoice_payment_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  UPDATE finance_invoice i
  SET status=CASE
        WHEN NEW.status='SETTLED' THEN 'PAID'
        WHEN NEW.status='PARTIALLY_SETTLED' THEN 'PARTIALLY_PAID'
        WHEN NEW.status='CANCELLED' THEN 'CANCELLED'
        ELSE CASE
          WHEN i.status IN ('CANCELLED','CREDITED') THEN i.status
          ELSE 'ISSUED'
        END
      END,
      updated_at=now()
  WHERE i.tenant_id=NEW.tenant_id
    AND i.obligation_id=NEW.id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER sync_invoice_payment_status_v1
AFTER UPDATE OF status,settled_minor ON financial_obligation
FOR EACH ROW EXECUTE FUNCTION corebiz_sync_invoice_payment_status();

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'finance.invoice.read','all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','FINANCE','VIEWER')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'finance.invoice.manage','all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','FINANCE')
ON CONFLICT DO NOTHING;

COMMIT;
