BEGIN;

-- Preserve existing UUID references, snapshots and issue IDs. Only expand
-- the set of monitored business domains; never rewrite historical migrations.
ALTER TABLE tenant_operational_issue
  DROP CONSTRAINT IF EXISTS tenant_operational_issue_issue_code_check;
ALTER TABLE tenant_operational_issue
  ADD CONSTRAINT tenant_operational_issue_issue_code_check
  CHECK(issue_code IN (
    'BANK_UNMATCHED','VAT_UNREGISTERED','CLOSE_BLOCKED','PAYROLL_DRAFT',
    'SALES_UNFULFILLED','PROCUREMENT_OVERDUE','SERVICE_UNCLOSED',
    'DANCE_UNCLOSED','DANCE_MISSING_MARGIN','AUTOMOTIVE_OVERDUE',
    'MARKETPLACE_UNMAPPED','MARKETPLACE_STOCK_BLOCKED',
    'PROJECT_DELIVERABLE_OVERDUE','WMS_TASK_FAILED','FINANCE_OVERDUE',
    'CRM_ACTION_OVERDUE','SUPPORT_ESCALATED'
  ));

CREATE INDEX IF NOT EXISTS operational_issue_open_by_type_idx
ON tenant_operational_issue(tenant_id,issue_code,reference_id)
WHERE state='OPEN';

CREATE INDEX IF NOT EXISTS service_booking_owner_unclosed_idx
ON service_booking(tenant_id,ends_at,id)
WHERE status IN ('CONFIRMED','ARRIVED','IN_SERVICE');

CREATE INDEX IF NOT EXISTS dance_lesson_owner_open_idx
ON dance_lesson(tenant_id,ends_at,id)
WHERE status IN ('PLANNED','OPEN_FOR_BOOKING','STARTED');

CREATE INDEX IF NOT EXISTS purchase_owner_overdue_idx
ON purchase_order(tenant_id,expected_at,id)
WHERE status IN ('CONFIRMED','PARTIALLY_RECEIVED') AND expected_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS automotive_owner_overdue_idx
ON automotive_work_order(tenant_id,promised_at,id)
WHERE promised_at IS NOT NULL AND status NOT IN ('DELIVERED','CANCELLED');

CREATE INDEX IF NOT EXISTS marketplace_owner_mapping_idx
ON channel_order_inbox(tenant_id,received_at,id)
WHERE status IN ('FAILED','NEEDS_MAPPING');

CREATE INDEX IF NOT EXISTS agency_owner_deliverables_idx
ON work_project_deliverable(tenant_id,due_at,id)
WHERE due_at IS NOT NULL AND status NOT IN ('APPROVED','CANCELLED');

CREATE INDEX IF NOT EXISTS finance_owner_overdue_idx
ON financial_obligation(tenant_id,due_at,id)
WHERE status IN ('OPEN','PARTIALLY_SETTLED') AND due_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS support_owner_urgent_idx
ON support_ticket(tenant_id,updated_at,id)
WHERE status IN ('NEW','OPEN','WAITING_SUPPORT') AND priority IN ('HIGH','URGENT');

COMMIT;
