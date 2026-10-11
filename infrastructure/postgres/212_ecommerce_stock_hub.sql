BEGIN;
-- Channel stock is an allocated share of the same physical seller stock.
-- Marketplace-owned FBO/FBW stock is deliberately excluded.
CREATE TABLE channel_stock_listing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES channel_connection(id) ON DELETE CASCADE,
  mapping_id uuid NOT NULL REFERENCES channel_product_mapping(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE RESTRICT,
  external_warehouse_id text,
  priority integer NOT NULL DEFAULT 100 CHECK(priority BETWEEN 1 AND 10000),
  enabled boolean NOT NULL DEFAULT true,
  publish_enabled boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'SETUP' CHECK(status IN ('SETUP','ACTIVE','PAUSED')),
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,connection_id,mapping_id,warehouse_id)
);
CREATE INDEX channel_stock_listing_pool_idx ON channel_stock_listing(tenant_id,warehouse_id,sku_id,enabled,priority);
CREATE TABLE channel_stock_target (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES channel_stock_listing(id) ON DELETE CASCADE,
  target_units integer NOT NULL DEFAULT 0 CHECK(target_units>=0),
  published_units integer CHECK(published_units IS NULL OR published_units>=0),
  generation bigint NOT NULL DEFAULT 1,
  published_generation bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'PAUSED' CHECK(status IN ('PAUSED','PENDING','SENDING','SYNCED','RETRY','BLOCKED')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at timestamptz,
  lease_until timestamptz,
  last_published_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,listing_id)
);
CREATE INDEX channel_stock_target_work_idx ON channel_stock_target(status,next_attempt_at,updated_at)
 WHERE status IN ('PENDING','RETRY','SENDING');
CREATE TABLE channel_stock_dirty (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE CASCADE,
  queued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,warehouse_id,sku_id)
);
ALTER TABLE channel_stock_listing ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_stock_target ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_stock_dirty ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['channel_stock_listing','channel_stock_target','channel_stock_dirty'] LOOP
  EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',name||'_isolation',name);
 END LOOP;
END;$$;
-- One provider listing cannot silently refer to another tenant's offer or SKU.
CREATE OR REPLACE FUNCTION corebiz_validate_channel_stock_listing() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM channel_product_mapping m
   JOIN channel_connection c ON c.id=m.connection_id AND c.tenant_id=m.tenant_id
   JOIN warehouse w ON w.id=NEW.warehouse_id AND w.tenant_id=m.tenant_id
   WHERE m.id=NEW.mapping_id AND m.connection_id=NEW.connection_id
     AND m.tenant_id=NEW.tenant_id AND m.sku_id=NEW.sku_id
     AND m.status='ACTIVE' AND w.status='ACTIVE' AND c.status<>'DISABLED'
 ) THEN
  RAISE EXCEPTION 'Stock listing must reference matching active connection, mapping, SKU and warehouse' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER channel_stock_listing_scope BEFORE INSERT OR UPDATE OF connection_id,mapping_id,sku_id,warehouse_id
 ON channel_stock_listing FOR EACH ROW EXECUTE FUNCTION corebiz_validate_channel_stock_listing();
-- Mark the affected SKU dirty whenever local physical or reserved stock changes.
CREATE OR REPLACE FUNCTION corebiz_mark_stock_pool_dirty() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 INSERT INTO channel_stock_dirty(tenant_id,warehouse_id,sku_id)
 VALUES(NEW.tenant_id,NEW.warehouse_id,NEW.sku_id)
 ON CONFLICT(tenant_id,warehouse_id,sku_id) DO UPDATE SET queued_at=now();
 RETURN NEW;
END;$$;
CREATE TRIGGER channel_stock_inventory_dirty AFTER INSERT OR UPDATE OF physical_milli,reserved_milli
 ON inventory_balance FOR EACH ROW EXECUTE FUNCTION corebiz_mark_stock_pool_dirty();
-- Imported marketplace order lines stay as shadow demand until sales/OMS takes over.
-- Lines without a mapping are blocked from publication by reconciliation.
CREATE OR REPLACE FUNCTION corebiz_mark_stock_order_dirty() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE affected record;
BEGIN
 FOR affected IN
  SELECT DISTINCT l.warehouse_id,l.sku_id
  FROM channel_stock_listing l
  WHERE l.tenant_id=NEW.tenant_id AND l.sku_id IN (
    SELECT li.mapped_sku_id FROM channel_order_line_inbox li
    WHERE li.tenant_id=NEW.tenant_id AND li.inbox_order_id=NEW.id
      AND li.mapped_sku_id IS NOT NULL
  )
 LOOP
  INSERT INTO channel_stock_dirty(tenant_id,warehouse_id,sku_id)
  VALUES(NEW.tenant_id,affected.warehouse_id,affected.sku_id)
  ON CONFLICT(tenant_id,warehouse_id,sku_id) DO UPDATE SET queued_at=now();
 END LOOP;
 RETURN NEW;
END;$$;
CREATE TRIGGER channel_stock_order_dirty AFTER INSERT OR UPDATE OF status,sales_order_id
 ON channel_order_inbox FOR EACH ROW EXECUTE FUNCTION corebiz_mark_stock_order_dirty();
CREATE OR REPLACE FUNCTION corebiz_mark_stock_line_dirty() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE affected record;
BEGIN
 FOR affected IN
   SELECT DISTINCT l.warehouse_id,l.sku_id
   FROM channel_stock_listing l
   WHERE l.tenant_id=COALESCE(NEW.tenant_id,OLD.tenant_id)
     AND l.sku_id IN (COALESCE(NEW.mapped_sku_id,OLD.mapped_sku_id))
 LOOP
   INSERT INTO channel_stock_dirty(tenant_id,warehouse_id,sku_id)
   VALUES(COALESCE(NEW.tenant_id,OLD.tenant_id),affected.warehouse_id,affected.sku_id)
   ON CONFLICT(tenant_id,warehouse_id,sku_id) DO UPDATE SET queued_at=now();
 END LOOP;
 RETURN COALESCE(NEW,OLD);
END;$$;
CREATE TRIGGER channel_stock_line_dirty AFTER INSERT OR DELETE OR UPDATE OF mapped_sku_id,quantity_milli
 ON channel_order_line_inbox FOR EACH ROW EXECUTE FUNCTION corebiz_mark_stock_line_dirty();
COMMIT;