BEGIN;

CREATE OR REPLACE FUNCTION corebiz_room_rental_contract_overlap_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NEW.status<>'ACTIVE' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      NEW.tenant_id::text || '|room-rental|' || NEW.room_resource_id::text,
      0
    )
  );

  IF EXISTS(
    SELECT 1
    FROM room_rental_contract c
    WHERE c.tenant_id=NEW.tenant_id
      AND c.room_resource_id=NEW.room_resource_id
      AND c.status='ACTIVE'
      AND c.id<>NEW.id
      AND daterange(c.valid_from,c.valid_to,'[]')
          && daterange(NEW.valid_from,NEW.valid_to,'[]')
  ) THEN
    RAISE EXCEPTION
      'Active room rental contracts overlap for room %',
      NEW.room_resource_id
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS room_rental_contract_overlap_guard_v1
  ON room_rental_contract;
CREATE TRIGGER room_rental_contract_overlap_guard_v1
BEFORE INSERT OR UPDATE OF
  room_resource_id,valid_from,valid_to,status
ON room_rental_contract
FOR EACH ROW
EXECUTE FUNCTION corebiz_room_rental_contract_overlap_guard();

COMMIT;
