BEGIN;
-- Preserve all historical issue codes. A failing FBS stock / order feed must
-- be visible to the company operator, not silently disappear from dashboards.
ALTER TABLE tenant_operational_issue
  DROP CONSTRAINT IF EXISTS tenant_operational_issue_issue_code_check;

ALTER TABLE tenant_operational_issue
  ADD CONSTRAINT tenant_operational_issue_issue_code_check
  CHECK(issue_code IN (
    'BANK_UNMATCHED','VAT_UNREGISTERED','CLOSE_BLOCKED','PAYROLL_DRAFT',
    'SALES_UNFULFILLED','PROCUREMENT_OVERDUE','SERVICE_UNCLOSED',
    'DANCE_UNCLOSED','DANCE_MISSING_MARGIN','AUTOMOTIVE_OVERDUE',
    'MARKETPLACE_UNMAPPED','MARKETPLACE_STOCK_BLOCKED',
    'MARKETPLACE_EXCESS_PUBLICATION','MARKETPLACE_ORDER_FEED_STALE',
    'PROJECT_DELIVERABLE_OVERDUE','WMS_TASK_FAILED','FINANCE_OVERDUE',
    'CRM_ACTION_OVERDUE','SUPPORT_ESCALATED'
  ));

CREATE INDEX IF NOT EXISTS channel_stock_live_pools_idx
  ON channel_stock_listing(tenant_id,warehouse_id,sku_id,connection_id)
  WHERE enabled AND publish_enabled;

CREATE INDEX IF NOT EXISTS channel_stock_published_pool_idx
  ON channel_stock_listing(tenant_id,warehouse_id,sku_id,id);

COMMIT;