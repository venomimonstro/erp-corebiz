BEGIN;

ALTER TABLE service_package_redemption
  ADD COLUMN IF NOT EXISTS package_entitlement_id uuid
    REFERENCES service_package_entitlement(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS service_package_redemption_entitlement_idx
  ON service_package_redemption(
    tenant_id,package_entitlement_id,state
  )
  WHERE package_entitlement_id IS NOT NULL;

COMMIT;
