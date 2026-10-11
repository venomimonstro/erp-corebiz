BEGIN;

-- Offer mapping search for tenants managing hundreds of thousands of offers.
-- pg_trgm is already installed by migration 222_catalog_million_sku_indexes.
CREATE INDEX IF NOT EXISTS channel_product_mapping_active_seek_idx
  ON channel_product_mapping(tenant_id,connection_id,id)
  WHERE status='ACTIVE';

CREATE INDEX IF NOT EXISTS channel_product_mapping_offer_trgm_idx
  ON channel_product_mapping USING gin(external_offer_id gin_trgm_ops)
  WHERE status='ACTIVE';

-- Separate channel-stock filters: warehouses/SKU are always scoped to tenant.
CREATE INDEX IF NOT EXISTS channel_stock_listing_tenant_sku_idx
  ON channel_stock_listing(tenant_id,sku_id,warehouse_id);

COMMIT;
