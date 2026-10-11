BEGIN;
-- A retry of one manually-created charge must not produce a second debt,
-- finance invoice, payment obligation or audit event.
ALTER TABLE dance_student_charge
  ADD COLUMN IF NOT EXISTS request_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS dance_student_charge_request_key_uq
  ON dance_student_charge(tenant_id,request_key)
  WHERE request_key IS NOT NULL;
COMMIT;