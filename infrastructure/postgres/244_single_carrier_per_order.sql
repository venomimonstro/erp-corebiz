BEGIN;
-- A single paid storefront order can be consigned to EXACTLY one carrier.
-- All claims, including UNKNOWN, continue to own the order. Manual recovery
-- must reconcile with the provider before any operational release.
DO $$
BEGIN
  IF EXISTS(
    SELECT 1 FROM commerce_shipment c
    JOIN commerce_post_shipment p
      ON p.tenant_id=c.tenant_id AND p.sales_order_id=c.sales_order_id
  ) THEN
    RAISE EXCEPTION 'CARRIER_CONFLICT: reconcile existing CDEK/Post claims before migration 244';
  END IF;
END $$;

CREATE FUNCTION corebiz_one_carrier_per_sales_order()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp
AS $$
BEGIN
  -- Both carriers serialize on the real Sales order, NOT on disjoint carrier
  -- tables (which would admit write-skew during simultaneous inserts).
  PERFORM 1 FROM sales_order
   WHERE tenant_id=NEW.tenant_id AND id=NEW.sales_order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CARRIER_ORDER_NOT_FOUND'
      USING ERRCODE='23503';
  END IF;
  IF TG_TABLE_NAME='commerce_shipment' THEN
    IF EXISTS(
      SELECT 1 FROM commerce_post_shipment
      WHERE tenant_id=NEW.tenant_id AND sales_order_id=NEW.sales_order_id
    ) THEN
      RAISE EXCEPTION 'CARRIER_ALREADY_CLAIMED_BY_RUSSIAN_POST'
        USING ERRCODE='23505';
    END IF;
  ELSE
    IF EXISTS(
      SELECT 1 FROM commerce_shipment
      WHERE tenant_id=NEW.tenant_id AND sales_order_id=NEW.sales_order_id
    ) THEN
      RAISE EXCEPTION 'CARRIER_ALREADY_CLAIMED_BY_CDEK'
        USING ERRCODE='23505';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER corebiz_one_cdek_for_order
 BEFORE INSERT OR UPDATE OF tenant_id,sales_order_id
 ON commerce_shipment
 FOR EACH ROW EXECUTE FUNCTION corebiz_one_carrier_per_sales_order();

CREATE TRIGGER corebiz_one_post_for_order
 BEFORE INSERT OR UPDATE OF tenant_id,sales_order_id
 ON commerce_post_shipment
 FOR EACH ROW EXECUTE FUNCTION corebiz_one_carrier_per_sales_order();
COMMIT;
