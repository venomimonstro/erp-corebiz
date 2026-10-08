-- Sprint 44a: tenant-safe 3PL owner references at the database boundary.
-- Prevent cross-tenant owner assignments even when the API is bypassed.
BEGIN;

CREATE OR REPLACE FUNCTION corebiz_validate_inventory_owner_tenant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_owner uuid;
BEGIN
  selected_owner := NULLIF(to_jsonb(NEW)->>TG_ARGV[0], '')::uuid;
  IF selected_owner IS NULL THEN
    RETURN NEW; -- legacy nullable task references remain supported
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM inventory_owner o
    WHERE o.id = selected_owner AND o.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'Inventory owner does not belong to tenant'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  item record;
  invalid_count bigint;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('warehouse_3pl_contract','owner_id'),
      ('inventory_owner_balance','owner_id'),
      ('warehouse_location_owner_balance','owner_id'),
      ('inventory_owner_movement','owner_id'),
      ('warehouse_location_owner_movement','owner_id'),
      ('sales_order','inventory_owner_id'),
      ('purchase_order','inventory_owner_id'),
      ('goods_receipt','inventory_owner_id'),
      ('inventory_reservation','owner_id'),
      ('inventory_transaction','owner_id'),
      ('wms_pick_allocation','owner_id'),
      ('warehouse_task','owner_id')
    ) AS v(table_name, owner_column)
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I t LEFT JOIN inventory_owner o ON o.id=t.%I AND o.tenant_id=t.tenant_id WHERE t.%I IS NOT NULL AND o.id IS NULL',
      item.table_name, item.owner_column, item.owner_column
    ) INTO invalid_count;
    IF invalid_count > 0 THEN
      RAISE EXCEPTION '3PL tenant integrity check failed: % has % invalid owner references',
        item.table_name, invalid_count;
    END IF;

    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF tenant_id, %I ON %I FOR EACH ROW EXECUTE FUNCTION corebiz_validate_inventory_owner_tenant(%L)',
      'validate_inventory_owner_tenant_v1', item.owner_column,
      item.table_name, item.owner_column
    );
  END LOOP;
END;
$$;

COMMIT;
