BEGIN;

CREATE TABLE service_booking_charge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES service_booking(id) ON DELETE RESTRICT,
  payer_party_id uuid NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  currency char(3) NOT NULL DEFAULT 'RUB',
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  due_at timestamptz,
  obligation_id uuid REFERENCES financial_obligation(id) ON DELETE RESTRICT,
  invoice_id uuid REFERENCES finance_invoice(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','PARTIALLY_PAID','PAID','CANCELLED')),
  created_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,booking_id),
  UNIQUE (tenant_id,id)
);

CREATE INDEX service_booking_charge_open_idx
  ON service_booking_charge(
    tenant_id,payer_party_id,status,due_at,created_at DESC
  );

ALTER TABLE service_booking_charge ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_booking_charge_isolation
  ON service_booking_charge
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

ALTER TABLE finance_invoice
  DROP CONSTRAINT IF EXISTS finance_invoice_source_type_check;

ALTER TABLE finance_invoice
  ADD CONSTRAINT finance_invoice_source_type_check
  CHECK (
    source_type IN (
      'WMS_3PL_STATEMENT',
      'DANCE_STUDENT_CHARGE',
      'SERVICE_BOOKING_CHARGE'
    )
  );

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

  IF NEW.source_type='DANCE_STUDENT_CHARGE' AND NOT EXISTS (
    SELECT 1
    FROM dance_student_charge c
    WHERE c.id=NEW.source_id
      AND c.tenant_id=NEW.tenant_id
      AND c.payer_party_id=NEW.party_id
      AND c.currency=NEW.currency
      AND c.amount_minor=NEW.amount_minor
      AND c.status <> 'CANCELLED'
  ) THEN
    RAISE EXCEPTION 'Invoice dance charge snapshot mismatch'
      USING ERRCODE='23514';
  END IF;

  IF NEW.source_type='SERVICE_BOOKING_CHARGE' AND NOT EXISTS (
    SELECT 1
    FROM service_booking_charge c
    JOIN service_booking b
      ON b.tenant_id=c.tenant_id AND b.id=c.booking_id
    WHERE c.id=NEW.source_id
      AND c.tenant_id=NEW.tenant_id
      AND c.payer_party_id=NEW.party_id
      AND c.currency=NEW.currency
      AND c.amount_minor=NEW.amount_minor
      AND c.status <> 'CANCELLED'
      AND b.status <> 'CANCELLED'
  ) THEN
    RAISE EXCEPTION 'Invoice service booking charge snapshot mismatch'
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

CREATE OR REPLACE FUNCTION corebiz_sync_service_booking_charge_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  UPDATE service_booking_charge c
  SET status=CASE
        WHEN NEW.status='SETTLED' THEN 'PAID'
        WHEN NEW.status='PARTIALLY_SETTLED' THEN 'PARTIALLY_PAID'
        WHEN NEW.status='CANCELLED' THEN 'CANCELLED'
        ELSE 'OPEN'
      END,
      updated_at=now()
  WHERE c.tenant_id=NEW.tenant_id
    AND c.obligation_id=NEW.id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER sync_service_booking_charge_status_v1
AFTER UPDATE OF status,settled_minor ON financial_obligation
FOR EACH ROW EXECUTE FUNCTION corebiz_sync_service_booking_charge_status();

CREATE TRIGGER service_booking_charge_tenant_refs_v1
BEFORE INSERT OR UPDATE ON service_booking_charge
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'booking_id','service_booking',
  'payer_party_id','party',
  'obligation_id','financial_obligation',
  'invoice_id','finance_invoice',
  'created_by_membership_id','tenant_membership'
);

COMMIT;
