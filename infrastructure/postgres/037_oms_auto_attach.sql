BEGIN;

CREATE OR REPLACE FUNCTION corebiz_sales_order_oms_attach()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.order_status = 'CONFIRMED'
     AND OLD.order_status IS DISTINCT FROM NEW.order_status
  THEN
    INSERT INTO oms_order(tenant_id,sales_order_id)
    VALUES (NEW.tenant_id,NEW.id)
    ON CONFLICT (tenant_id,sales_order_id) DO NOTHING;
  END IF;

  IF NEW.order_status = 'CANCELLED'
     AND OLD.order_status IS DISTINCT FROM NEW.order_status
  THEN
    UPDATE oms_order
    SET state='CANCELLED',updated_at=now()
    WHERE tenant_id=NEW.tenant_id
      AND sales_order_id=NEW.id
      AND state <> 'SHIPPED';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_order_oms_attach ON sales_order;

CREATE TRIGGER sales_order_oms_attach
AFTER UPDATE OF order_status ON sales_order
FOR EACH ROW
EXECUTE FUNCTION corebiz_sales_order_oms_attach();

INSERT INTO oms_order(tenant_id,sales_order_id)
SELECT tenant_id,id
FROM sales_order
WHERE order_status='CONFIRMED'
ON CONFLICT (tenant_id,sales_order_id) DO NOTHING;

COMMIT;
