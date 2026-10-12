BEGIN;
-- Add distinct operations without reusing the first receipt identity.
-- A bank refund remains authoritative independently of the fiscal receipt.
ALTER TABLE commerce_fiscal_document
 DROP CONSTRAINT commerce_fiscal_document_operation_check;
ALTER TABLE commerce_fiscal_document
 ADD CONSTRAINT commerce_fiscal_document_operation_check
 CHECK(operation IN ('sell','sell_full_payment','sell_refund'));
ALTER TABLE commerce_fiscal_document
 ADD COLUMN refund_id uuid REFERENCES commerce_refund(id) ON DELETE RESTRICT;
ALTER TABLE commerce_fiscal_document
 ADD CONSTRAINT commerce_fiscal_refund_identity
 CHECK ((operation='sell_refund' AND refund_id IS NOT NULL)
   OR (operation<>'sell_refund' AND refund_id IS NULL));
CREATE UNIQUE INDEX commerce_fiscal_single_refund_per_bank_refund
 ON commerce_fiscal_document(tenant_id,refund_id)
 WHERE refund_id IS NOT NULL;
CREATE INDEX commerce_fiscal_payment_ops
 ON commerce_fiscal_document(tenant_id,payment_intent_id,operation,state);

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='corebiz_app') THEN
  GRANT SELECT,INSERT,UPDATE ON commerce_fiscal_document TO corebiz_app;
 END IF;
END $$;
COMMIT;
