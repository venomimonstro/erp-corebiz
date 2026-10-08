BEGIN;

ALTER TABLE wms_3pl_statement_line
  ADD COLUMN rate_id uuid REFERENCES wms_3pl_rate(id) ON DELETE RESTRICT;

ALTER TABLE wms_3pl_statement_line
  DROP CONSTRAINT IF EXISTS wms_3pl_statement_line_statement_id_service_code_key;

CREATE UNIQUE INDEX wms_3pl_statement_line_rate_uq
  ON wms_3pl_statement_line(statement_id,service_code,rate_id);

CREATE INDEX wms_3pl_statement_owner_period_idx
  ON wms_3pl_statement(tenant_id,owner_id,period_from DESC,period_to DESC);

COMMIT;
