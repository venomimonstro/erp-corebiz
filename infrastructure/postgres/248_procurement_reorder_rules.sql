BEGIN;

-- Per-SKU procurement policy. This is NOT inventory_policy:
-- inventory_policy controls allocation/safety stock per warehouse;
-- this table controls purchasing lead/review horizon for the whole tenant.
CREATE TABLE IF NOT EXISTS procurement_reorder_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE CASCADE,
  lead_days integer NOT NULL DEFAULT 7 CHECK (lead_days BETWEEN 1 AND 180),
  review_days integer NOT NULL DEFAULT 7 CHECK (review_days BETWEEN 1 AND 90),
  minimum_batch_milli bigint NOT NULL DEFAULT 0 CHECK (minimum_batch_milli>=0),
  enabled boolean NOT NULL DEFAULT true,
  updated_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,sku_id)
);
CREATE INDEX IF NOT EXISTS procurement_reorder_rule_tenant_idx
  ON procurement_reorder_rule(tenant_id,enabled,sku_id);
ALTER TABLE procurement_reorder_rule ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS procurement_reorder_rule_isolation ON procurement_reorder_rule;
CREATE POLICY procurement_reorder_rule_isolation ON procurement_reorder_rule
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
COMMIT;
