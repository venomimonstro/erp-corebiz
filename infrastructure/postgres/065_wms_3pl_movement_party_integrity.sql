-- Sprint 44c: protect 3PL ledger endpoints and owner/customer identity.
-- Abort on legacy violations; never silently reassign stock ownership.
BEGIN;

CREATE OR REPLACE FUNCTION corebiz_validate_3pl_movement_locations()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  endpoint_id uuid;
BEGIN
  FOREACH endpoint_id IN ARRAY ARRAY[NEW.from_location_id, NEW.to_location_id]
  LOOP
    IF endpoint_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM warehouse_location l
      WHERE l.id = endpoint_id
        AND l.tenant_id = NEW.tenant_id
        AND l.warehouse_id = NEW.warehouse_id
    ) THEN
      RAISE EXCEPTION '3PL movement endpoint is outside warehouse or tenant'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION corebiz_validate_3pl_owner_party()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.party_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM party p
    WHERE p.id = NEW.party_id
      AND p.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'Inventory owner party belongs to another tenant'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.owner_type = 'CLIENT' AND NEW.party_id IS NULL THEN
    RAISE EXCEPTION 'Client inventory owner requires a party'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.owner_type = 'INTERNAL' AND NEW.party_id IS NOT NULL THEN
    RAISE EXCEPTION 'Internal inventory owner must not have a party'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  count_invalid bigint;
BEGIN
  SELECT count(*) INTO count_invalid
  FROM warehouse_location_owner_movement m
  LEFT JOIN warehouse_location src
    ON src.id=m.from_location_id
   AND src.tenant_id=m.tenant_id
   AND src.warehouse_id=m.warehouse_id
  LEFT JOIN warehouse_location dst
    ON dst.id=m.to_location_id
   AND dst.tenant_id=m.tenant_id
   AND dst.warehouse_id=m.warehouse_id
  WHERE (m.from_location_id IS NOT NULL AND src.id IS NULL)
     OR (m.to_location_id IS NOT NULL AND dst.id IS NULL);
  IF count_invalid > 0 THEN
    RAISE EXCEPTION 'Found % invalid 3PL movement location endpoints', count_invalid;
  END IF;

  SELECT count(*) INTO count_invalid
  FROM inventory_owner o
  LEFT JOIN party p
    ON p.id=o.party_id AND p.tenant_id=o.tenant_id
  WHERE (o.party_id IS NOT NULL AND p.id IS NULL)
     OR (o.owner_type='CLIENT' AND o.party_id IS NULL)
     OR (o.owner_type='INTERNAL' AND o.party_id IS NOT NULL);
  IF count_invalid > 0 THEN
    RAISE EXCEPTION 'Found % invalid inventory owner party references', count_invalid;
  END IF;
END;
$$;

CREATE TRIGGER validate_3pl_movement_locations_v1
BEFORE INSERT OR UPDATE OF tenant_id,warehouse_id,from_location_id,to_location_id
ON warehouse_location_owner_movement
FOR EACH ROW EXECUTE FUNCTION corebiz_validate_3pl_movement_locations();

CREATE TRIGGER validate_3pl_owner_party_v1
BEFORE INSERT OR UPDATE OF tenant_id,party_id,owner_type
ON inventory_owner
FOR EACH ROW EXECUTE FUNCTION corebiz_validate_3pl_owner_party();

COMMIT;
