BEGIN;

ALTER TABLE return_request
  ADD COLUMN IF NOT EXISTS inventory_owner_id uuid
  REFERENCES inventory_owner(id) ON DELETE RESTRICT;

UPDATE return_request rr
SET inventory_owner_id=so.inventory_owner_id
FROM sales_order so
WHERE so.tenant_id=rr.tenant_id
  AND so.id=rr.sales_order_id
  AND rr.inventory_owner_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM return_request rr
    LEFT JOIN sales_order so
      ON so.tenant_id=rr.tenant_id
     AND so.id=rr.sales_order_id
    WHERE rr.inventory_owner_id IS NULL
       OR so.id IS NULL
       OR so.inventory_owner_id IS DISTINCT FROM rr.inventory_owner_id
  ) THEN
    RAISE EXCEPTION 'Historical return owner mismatch; reconcile before migration';
  END IF;
END;
$$;

ALTER TABLE return_request
  ALTER COLUMN inventory_owner_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS return_request_owner_idx
  ON return_request(tenant_id,inventory_owner_id,status,requested_at DESC);

CREATE OR REPLACE FUNCTION corebiz_validate_return_owner()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM sales_order so
    WHERE so.tenant_id=NEW.tenant_id
      AND so.id=NEW.sales_order_id
      AND so.inventory_owner_id=NEW.inventory_owner_id
  ) THEN
    RAISE EXCEPTION 'Return owner must match sales order owner'
      USING ERRCODE='23514';
  END IF;

  IF TG_OP='UPDATE'
     AND NEW.inventory_owner_id IS DISTINCT FROM OLD.inventory_owner_id
  THEN
    RAISE EXCEPTION 'Return owner is immutable'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_return_owner_v1 ON return_request;
CREATE TRIGGER validate_return_owner_v1
BEFORE INSERT OR UPDATE OF tenant_id,sales_order_id,inventory_owner_id
ON return_request
FOR EACH ROW EXECUTE FUNCTION corebiz_validate_return_owner();

COMMIT;
