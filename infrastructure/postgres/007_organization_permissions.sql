BEGIN;

INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
SELECT r.tenant_id, r.id, 'organization.write', 'all'
FROM tenant_role r
WHERE r.code = 'ADMIN'
ON CONFLICT DO NOTHING;

INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
SELECT r.tenant_id, r.id, 'organization.read', 'all'
FROM tenant_role r
WHERE r.code IN (
  'ADMIN','SALES_HEAD','SALES_MANAGER','PROCUREMENT','WAREHOUSE','FINANCE','VIEWER'
)
ON CONFLICT DO NOTHING;

COMMIT;
