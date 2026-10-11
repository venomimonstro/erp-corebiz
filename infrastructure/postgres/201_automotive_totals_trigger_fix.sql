BEGIN;

CREATE OR REPLACE FUNCTION corebiz_automotive_work_order_recalculate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  target_tenant uuid;
  target_order uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    target_tenant:=OLD.tenant_id;
    target_order:=OLD.work_order_id;
  ELSE
    target_tenant:=NEW.tenant_id;
    target_order:=NEW.work_order_id;
  END IF;

  UPDATE automotive_work_order o
  SET
    estimated_total_minor=coalesce((
      SELECT sum((l.unit_price_minor*l.quantity_milli+999)/1000)
      FROM automotive_work_order_line l
      WHERE l.tenant_id=o.tenant_id
        AND l.work_order_id=o.id
        AND l.approved=true
    ),0),
    actual_total_minor=coalesce((
      SELECT sum((l.unit_price_minor*l.quantity_milli+999)/1000)
      FROM automotive_work_order_line l
      WHERE l.tenant_id=o.tenant_id
        AND l.work_order_id=o.id
        AND l.approved=true
        AND l.completed=true
    ),0),
    updated_at=now()
  WHERE o.tenant_id=target_tenant AND o.id=target_order;

  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
