BEGIN;

DROP TRIGGER IF EXISTS trainer_payroll_statement_tenant_refs_v1
  ON trainer_payroll_statement;
DROP TRIGGER IF EXISTS trainer_payroll_statement_tenant_refs_v2
  ON trainer_payroll_statement;

CREATE TRIGGER trainer_payroll_statement_tenant_refs_v2
BEFORE INSERT OR UPDATE ON trainer_payroll_statement
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'trainer_resource_id','service_resource',
  'payroll_batch_id','payroll_accrual_batch'
);

COMMIT;
