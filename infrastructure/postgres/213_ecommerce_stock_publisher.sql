BEGIN;
ALTER TABLE channel_stock_listing ADD COLUMN IF NOT EXISTS external_stock_id text;
-- Separate WB size identifier (chrtId) from seller article / offer mapping.
CREATE OR REPLACE FUNCTION corebiz_claim_stock_dirty()
RETURNS TABLE(tenant_id uuid,warehouse_id uuid,sku_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 RETURN QUERY
 WITH candidate AS (
  SELECT d.tenant_id,d.warehouse_id,d.sku_id
  FROM channel_stock_dirty d ORDER BY d.queued_at
  FOR UPDATE SKIP LOCKED LIMIT 1
 )
 DELETE FROM channel_stock_dirty d USING candidate c
 WHERE d.tenant_id=c.tenant_id AND d.warehouse_id=c.warehouse_id AND d.sku_id=c.sku_id
 RETURNING d.tenant_id,d.warehouse_id,d.sku_id;
END;$$;
REVOKE ALL ON FUNCTION corebiz_claim_stock_dirty() FROM PUBLIC;
CREATE OR REPLACE FUNCTION corebiz_claim_stock_target()
RETURNS TABLE(tenant_id uuid,listing_id uuid,connection_id uuid,provider text,
  external_offer_id text,external_stock_id text,external_warehouse_id text,
  target_units integer,generation bigint,credentials_ciphertext text,
  config jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 RETURN QUERY
 WITH candidate AS (
  SELECT t.tenant_id,t.listing_id
  FROM channel_stock_target t JOIN channel_stock_listing l
  ON l.tenant_id=t.tenant_id AND l.id=t.listing_id
  JOIN channel_connection c ON c.tenant_id=l.tenant_id AND c.id=l.connection_id
  WHERE (
    t.status IN ('PENDING','RETRY')
    OR (t.status='SENDING' AND t.lease_until<now())
  ) AND (t.next_attempt_at IS NULL OR t.next_attempt_at<=now())
    AND t.attempts<8 AND c.credentials_ciphertext IS NOT NULL
    AND c.status<>'DISABLED'
  ORDER BY CASE WHEN t.target_units=0 THEN 0 ELSE 1 END,t.updated_at
  FOR UPDATE OF t SKIP LOCKED LIMIT 1
 ), claimed AS (
  UPDATE channel_stock_target t
    SET status='SENDING',lease_until=now()+interval '90 seconds',
        attempts=t.attempts+1,updated_at=now()
  FROM candidate k WHERE t.tenant_id=k.tenant_id AND t.listing_id=k.listing_id
  RETURNING t.tenant_id,t.listing_id,t.target_units,t.generation
 )
 SELECT q.tenant_id,q.listing_id,c.id,c.provider,m.external_offer_id,
   l.external_stock_id,l.external_warehouse_id,q.target_units,q.generation,
   c.credentials_ciphertext,c.config
 FROM claimed q JOIN channel_stock_listing l ON l.tenant_id=q.tenant_id AND l.id=q.listing_id
 JOIN channel_product_mapping m ON m.tenant_id=l.tenant_id AND m.id=l.mapping_id
 JOIN channel_connection c ON c.tenant_id=l.tenant_id AND c.id=l.connection_id;
END;$$;
REVOKE ALL ON FUNCTION corebiz_claim_stock_target() FROM PUBLIC;
COMMIT;