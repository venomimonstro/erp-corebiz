BEGIN;

CREATE TABLE dance_student_charge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES dance_student(id) ON DELETE RESTRICT,
  payer_party_id uuid NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  source_type text NOT NULL
    CHECK (source_type IN ('PACKAGE','LESSON','INSTALLMENT','OTHER')),
  source_id uuid,
  currency char(3) NOT NULL DEFAULT 'RUB',
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  due_at timestamptz,
  obligation_id uuid REFERENCES financial_obligation(id) ON DELETE RESTRICT,
  invoice_id uuid,
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','PARTIALLY_PAID','PAID','CANCELLED')),
  note text,
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id)
);

CREATE UNIQUE INDEX dance_student_charge_source_uq
  ON dance_student_charge(tenant_id,student_id,source_type,source_id)
  WHERE source_id IS NOT NULL AND status <> 'CANCELLED';

CREATE INDEX dance_student_charge_open_idx
  ON dance_student_charge(tenant_id,payer_party_id,status,due_at);

ALTER TABLE dance_student_charge ENABLE ROW LEVEL SECURITY;
CREATE POLICY dance_student_charge_isolation
  ON dance_student_charge
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
  CHECK (source_type IN ('WMS_3PL_STATEMENT','DANCE_STUDENT_CHARGE'));

ALTER TABLE dance_student_charge
  ADD CONSTRAINT dance_student_charge_invoice_fk
  FOREIGN KEY (invoice_id) REFERENCES finance_invoice(id) ON DELETE RESTRICT;

ALTER TABLE payment
  ADD COLUMN IF NOT EXISTS allocation_fingerprint text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname='payment_allocation_fingerprint_ck'
      AND conrelid='payment'::regclass
  ) THEN
    ALTER TABLE payment
      ADD CONSTRAINT payment_allocation_fingerprint_ck
      CHECK (
        allocation_fingerprint IS NULL
        OR allocation_fingerprint ~ '^[0-9a-f]{64}$'
      );
  END IF;
END;
$$;

CREATE TABLE payment_allocation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES payment(id) ON DELETE RESTRICT,
  obligation_id uuid NOT NULL REFERENCES financial_obligation(id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,payment_id,obligation_id)
);

CREATE INDEX payment_allocation_obligation_idx
  ON payment_allocation(tenant_id,obligation_id,payment_id);

ALTER TABLE payment_allocation ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_allocation_isolation
  ON payment_allocation
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE OR REPLACE FUNCTION corebiz_payment_allocation_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  v_payment_amount bigint;
  v_payment_currency char(3);
  v_payment_party uuid;
  v_payment_direction text;
  v_obligation_currency char(3);
  v_obligation_party uuid;
  v_obligation_direction text;
  v_allocated bigint;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Payment allocation is immutable'
      USING ERRCODE='23514';
  END IF;

  SELECT amount_minor,currency,party_id,direction
  INTO v_payment_amount,v_payment_currency,v_payment_party,v_payment_direction
  FROM payment
  WHERE id=NEW.payment_id AND tenant_id=NEW.tenant_id AND status='POSTED'
  FOR SHARE;

  IF NOT FOUND OR v_payment_direction <> 'IN' THEN
    RAISE EXCEPTION 'Payment allocation requires posted incoming payment'
      USING ERRCODE='23514';
  END IF;

  SELECT currency,party_id,direction
  INTO v_obligation_currency,v_obligation_party,v_obligation_direction
  FROM financial_obligation
  WHERE id=NEW.obligation_id AND tenant_id=NEW.tenant_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_obligation_direction <> 'RECEIVABLE'
     OR v_obligation_currency <> v_payment_currency
     OR v_obligation_party IS DISTINCT FROM v_payment_party
  THEN
    RAISE EXCEPTION 'Payment allocation obligation mismatch'
      USING ERRCODE='23514';
  END IF;

  SELECT coalesce(sum(amount_minor),0)
  INTO v_allocated
  FROM payment_allocation
  WHERE tenant_id=NEW.tenant_id AND payment_id=NEW.payment_id;

  IF v_allocated + NEW.amount_minor > v_payment_amount THEN
    RAISE EXCEPTION 'Payment allocation exceeds payment amount'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_allocation_guard_v1
BEFORE INSERT OR UPDATE OR DELETE ON payment_allocation
FOR EACH ROW EXECUTE FUNCTION corebiz_payment_allocation_guard();

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

CREATE OR REPLACE FUNCTION corebiz_sync_dance_charge_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  UPDATE dance_student_charge c
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

DROP TRIGGER IF EXISTS sync_dance_charge_status_v1 ON financial_obligation;
CREATE TRIGGER sync_dance_charge_status_v1
AFTER UPDATE OF status,settled_minor ON financial_obligation
FOR EACH ROW EXECUTE FUNCTION corebiz_sync_dance_charge_status();

COMMIT;
