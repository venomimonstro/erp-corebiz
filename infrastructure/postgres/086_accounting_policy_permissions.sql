-- Sprint 51: separate accounting policy administration from ordinary journal posting.
BEGIN;
INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'accounting.policy.manage','all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','FINANCE')
ON CONFLICT DO NOTHING;
COMMIT;
