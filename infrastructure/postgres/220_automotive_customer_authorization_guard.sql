BEGIN;
-- Customer authorization is a hard ceiling for approved work, not merely a
-- field displayed on the repair order. All entry points share this DB guard.
CREATE OR REPLACE FUNCTION corebiz_enforce_automotive_authorization()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE ceiling bigint;
DECLARE approved_total numeric;
DECLARE v_tenant uuid;
DECLARE v_order uuid;
BEGIN
  v_tenant:=NEW.tenant_id;
  v_order:=NEW.work_order_id;
  SELECT authorization_limit_minor INTO ceiling
  FROM automotive_work_order
  WHERE tenant_id=v_tenant AND id=v_order FOR UPDATE;
  IF ceiling IS NULL THEN RETURN NEW; END IF;
  SELECT coalesce(sum(ceil(l.quantity_milli::numeric *
                   l.unit_price_minor::numeric / 1000)),0)
  INTO approved_total
  FROM automotive_work_order_line l
  WHERE l.tenant_id=v_tenant AND l.work_order_id=v_order
    AND l.approved;
  IF approved_total>ceiling THEN
    RAISE EXCEPTION 'Approved automotive work exceeds customer authorization'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;$$;

CREATE TRIGGER automotive_work_order_line_authorization_guard
AFTER INSERT OR UPDATE OF approved,unit_price_minor,quantity_milli,work_order_id
ON automotive_work_order_line FOR EACH ROW
EXECUTE FUNCTION corebiz_enforce_automotive_authorization();

CREATE OR REPLACE FUNCTION corebiz_enforce_automotive_ceiling_change()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE approved_total numeric;
BEGIN
  IF NEW.authorization_limit_minor IS NULL THEN RETURN NEW; END IF;
  SELECT coalesce(sum(ceil(l.quantity_milli::numeric *
                  l.unit_price_minor::numeric / 1000)),0)
  INTO approved_total
  FROM automotive_work_order_line l
  WHERE l.tenant_id=NEW.tenant_id AND l.work_order_id=NEW.id
    AND l.approved;
  IF approved_total>NEW.authorization_limit_minor THEN
    RAISE EXCEPTION 'Cannot reduce authorization below approved repair work'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;$$;

CREATE TRIGGER automotive_work_order_ceiling_guard
BEFORE UPDATE OF authorization_limit_minor
ON automotive_work_order FOR EACH ROW
EXECUTE FUNCTION corebiz_enforce_automotive_ceiling_change();

COMMIT;
