-- Sprint 44b: ensure 3PL warehouse, SKU and bin belong to the same tenant.
BEGIN;

CREATE OR REPLACE FUNCTION corebiz_validate_3pl_dimensions()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  ref_warehouse uuid := NULLIF(to_jsonb(NEW)->>'warehouse_id','')::uuid;
  ref_sku uuid := NULLIF(to_jsonb(NEW)->>'sku_id','')::uuid;
  ref_location uuid := NULLIF(to_jsonb(NEW)->>'location_id','')::uuid;
BEGIN
  IF ref_warehouse IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM warehouse w
    WHERE w.id=ref_warehouse AND w.tenant_id=NEW.tenant_id
  ) THEN
    RAISE EXCEPTION '3PL warehouse tenant mismatch' USING ERRCODE='23514';
  END IF;
  IF ref_sku IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sku s
    WHERE s.id=ref_sku AND s.tenant_id=NEW.tenant_id
  ) THEN
    RAISE EXCEPTION '3PL SKU tenant mismatch' USING ERRCODE='23514';
  END IF;
  IF ref_location IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM warehouse_location l
    WHERE l.id=ref_location AND l.tenant_id=NEW.tenant_id
      AND l.warehouse_id=ref_warehouse
  ) THEN
    RAISE EXCEPTION '3PL location warehouse/tenant mismatch'
      USING ERRCODE='23514';
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
      ('warehouse_3pl_contract',false,false),
      ('inventory_owner_balance',true,false),
      ('warehouse_location_owner_balance',true,true),
      ('inventory_owner_movement',true,false),
      ('warehouse_location_owner_movement',true,false)
    ) AS v(table_name, has_sku, has_location)
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I t LEFT JOIN warehouse w ON w.id=t.warehouse_id AND w.tenant_id=t.tenant_id WHERE w.id IS NULL',
      item.table_name
    ) INTO invalid_count;
    IF invalid_count>0 THEN
      RAISE EXCEPTION 'Invalid 3PL warehouse references in %: %',
        item.table_name,invalid_count;
    END IF;
    IF item.has_sku THEN
      EXECUTE format(
        'SELECT count(*) FROM %I t LEFT JOIN sku s ON s.id=t.sku_id AND s.tenant_id=t.tenant_id WHERE s.id IS NULL',
        item.table_name
      ) INTO invalid_count;
      IF invalid_count>0 THEN
        RAISE EXCEPTION 'Invalid 3PL SKU references in %: %',
          item.table_name,invalid_count;
      END IF;
    END IF;
    IF item.has_location THEN
      EXECUTE format(
        'SELECT count(*) FROM %I t LEFT JOIN warehouse_location l ON l.id=t.location_id AND l.tenant_id=t.tenant_id AND l.warehouse_id=t.warehouse_id WHERE l.id IS NULL',
        item.table_name
      ) INTO invalid_count;
      IF invalid_count>0 THEN
        RAISE EXCEPTION 'Invalid 3PL location references in %: %',
          item.table_name,invalid_count;
      END IF;
    END IF;
    EXECUTE format(
      'CREATE TRIGGER validate_3pl_dimensions_v1 BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION corebiz_validate_3pl_dimensions()',
      item.table_name
    );
  END LOOP;
END;
$$;

COMMIT;
