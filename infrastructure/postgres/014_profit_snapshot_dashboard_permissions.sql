BEGIN;

ALTER TABLE sales_order_line
  ADD COLUMN cost_price_minor_snapshot bigint NOT NULL DEFAULT 0
  CHECK (cost_price_minor_snapshot >= 0);

UPDATE sales_order_line l
SET cost_price_minor_snapshot = s.cost_price_minor
FROM sku s
WHERE s.tenant_id = l.tenant_id
  AND s.id = l.sku_id
  AND l.sku_id IS NOT NULL
  AND l.cost_price_minor_snapshot = 0;

INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
SELECT r.tenant_id, r.id, 'dashboard.owner.read', 'all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','FINANCE')
ON CONFLICT DO NOTHING;

COMMIT;
