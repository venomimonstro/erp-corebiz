BEGIN;

-- Enlarge monitored states without rewriting migrations previously applied.
ALTER TABLE tenant_operational_issue
  DROP CONSTRAINT IF EXISTS tenant_operational_issue_issue_code_check;
ALTER TABLE tenant_operational_issue
  ADD CONSTRAINT tenant_operational_issue_issue_code_check
  CHECK (issue_code IN (
    'BANK_UNMATCHED','VAT_UNREGISTERED','CLOSE_BLOCKED','PAYROLL_DRAFT',
    'SALES_UNFULFILLED','PROCUREMENT_OVERDUE','SERVICE_UNCLOSED',
    'DANCE_UNCLOSED','DANCE_MISSING_MARGIN','AUTOMOTIVE_OVERDUE',
    'MARKETPLACE_UNMAPPED','MARKETPLACE_STOCK_BLOCKED',
    'PROJECT_DELIVERABLE_OVERDUE','WMS_TASK_FAILED','FINANCE_OVERDUE',
    'CRM_ACTION_OVERDUE','SUPPORT_ESCALATED',
    'OMS_BACKORDER_OVERDUE','MARKETPLACE_FEED_STALE',
    'DANCE_STRANDED_VISIT','PAYROLL_REVIEW_DISPUTED',
    'PROJECT_CLIENT_APPROVAL_OVERDUE'
  ));

CREATE INDEX IF NOT EXISTS corebiz_oms_backorder_risk_idx
  ON oms_backorder_line(tenant_id,expected_at,created_at,id)
  WHERE status IN ('OPEN','PARTIALLY_ALLOCATED');

CREATE INDEX IF NOT EXISTS corebiz_marketplace_feed_risk_idx
  ON channel_stock_listing(tenant_id,connection_id,updated_at,id)
  WHERE publish_enabled=true AND enabled=true;

CREATE INDEX IF NOT EXISTS corebiz_package_redemption_stranded_idx
  ON dance_package_redemption(tenant_id,participant_id,id)
  WHERE state='RESERVED';

CREATE INDEX IF NOT EXISTS corebiz_payroll_dispute_risk_idx
  ON payroll_statement_review(tenant_id,updated_at,id)
  WHERE review_status='DISPUTED';

CREATE INDEX IF NOT EXISTS corebiz_project_client_approval_risk_idx
  ON work_project_client_approval(tenant_id,due_at,id)
  WHERE status='PENDING' AND due_at IS NOT NULL;

COMMIT;
