BEGIN;

-- Install before tenants reach million-SKU cardinality; these indexes can take
-- locks during first deployment. On already huge databases schedule maintenance
-- and install equivalent indexes CONCURRENTLY outside this migration instead.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Keyset page: SKU ids are stable and scoped to a tenant.
CREATE INDEX IF NOT EXISTS sku_tenant_active_seek_idx
  ON sku(tenant_id,id) WHERE status='ACTIVE';

-- Multi-million SKU substring lookup (barcode/offer, article, product name).
-- Keep normal B-tree indexes for exact lookup and uniqueness.
CREATE INDEX IF NOT EXISTS sku_code_trgm_lookup_idx
  ON sku USING gin(code gin_trgm_ops) WHERE status='ACTIVE';
CREATE INDEX IF NOT EXISTS sku_barcode_trgm_lookup_idx
  ON sku USING gin(barcode gin_trgm_ops)
  WHERE status='ACTIVE' AND barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS product_name_trgm_lookup_idx
  ON product USING gin(name gin_trgm_ops) WHERE status='ACTIVE';

COMMIT;
