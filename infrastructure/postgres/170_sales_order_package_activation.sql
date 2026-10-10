BEGIN;

CREATE OR REPLACE FUNCTION corebiz_sync_sales_order_package_activation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NEW.direction<>'RECEIVABLE'
     OR NEW.source_type<>'SALES_ORDER' THEN
    RETURN NEW;
  END IF;

  IF NEW.status='SETTLED' THEN
    UPDATE service_package sp
    SET status='ACTIVE',updated_at=now()
    WHERE sp.tenant_id=NEW.tenant_id
      AND sp.sales_order_id=NEW.source_id
      AND sp.activation_policy_snapshot='FULL_PAYMENT'
      AND sp.status='PENDING_PAYMENT';
  ELSIF NEW.status='CANCELLED' THEN
    UPDATE service_package sp
    SET status='CANCELLED',updated_at=now()
    WHERE sp.tenant_id=NEW.tenant_id
      AND sp.sales_order_id=NEW.source_id
      AND sp.activation_policy_snapshot='FULL_PAYMENT'
      AND sp.status='PENDING_PAYMENT'
      AND sp.reserved_visits=0
      AND sp.used_visits=0;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_sales_order_package_activation_v1
  ON financial_obligation;
CREATE TRIGGER sync_sales_order_package_activation_v1
AFTER INSERT OR UPDATE OF status,settled_minor
ON financial_obligation
FOR EACH ROW
EXECUTE FUNCTION corebiz_sync_sales_order_package_activation();

COMMIT;
